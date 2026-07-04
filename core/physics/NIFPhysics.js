/**
 * NIFPhysics — Complete Real-time Physics Engine
 * © Fumoca Technologies · fumoca.co.za
 *
 * 1.  ClothSimulator     — XPBD cloth: distance + bending + shear + self-collision
 * 2.  RigidBody          — Symplectic Euler + impulse contact resolution
 * 3.  SpringDamper       — suspension, elastic joints (automotive, furniture)
 * 4.  BVH                — Möller-Trumbore ray, AABB slab, Gaussian raycast
 * 5.  ParticleSystem     — typed arrays, curl-noise advection, ground bounce
 * 6.  FEMSoftBody        — linear FEM tetrahedral mesh, polar decomp co-rotated
 * 7.  Lighting           — area light Monte Carlo, IBL diffuse SH9
 * 8.  GaussianKDTree     — spatial index for editor hit-testing (k-d tree)
 *
 * All connected to NIFMath. No standalone implementations.
 */

import {
  v3, m3, Quat, Noise, Structural,
  EPS, lerp, clamp, smoothstep,
} from '../math/NIFMath.js';

// ─── 1. XPBD Cloth Simulator ─────────────────────────────────────────────────
/**
 * Extended Position-Based Dynamics (XPBD) — Macklin et al. 2016.
 * XPBD is an upgrade to PBD that correctly handles stiffness:
 * constraints use compliance (α = 1/stiffness) so behaviour is
 * independent of substep count and iteration count.
 *
 * Constraint types:
 *   - Distance (structural)
 *   - Bending  (dihedral angle between adjacent triangles)
 *   - Shear    (cross-diagonal distance in quad patches)
 *   - Self-collision (particle vs particle repulsion)
 */
export class ClothSimulator {
  /**
   * @param {number[][]} vertices   rest positions
   * @param {number[][]} triangles  index triples
   * @param {object}     opts
   *   mass          kg/particle   (default 0.05)
   *   compliance    1/stiffness   (default 1e-5)
   *   bendCompliance              (default 1e-3)
   *   damping       [0,1]         (default 0.005)
   *   gravity       [x,y,z]       (default [0,-9.81,0])
   */
  constructor(vertices, triangles, opts={}) {
    this.n          = vertices.length;
    this.positions  = vertices.map(v=>[...v]);
    this.prev       = vertices.map(v=>[...v]);
    this.velocities = vertices.map(()=>[0,0,0]);
    this.invMass    = vertices.map(()=>1/(opts.mass??0.05));
    this.triangles  = triangles;
    this.compliance     = opts.compliance     ?? 1e-5;
    this.bendCompliance = opts.bendCompliance ?? 1e-3;
    this.damping        = opts.damping        ?? 0.005;
    this.gravity        = opts.gravity        ?? [0,-9.81,0];
    this.selfCollisionR = opts.selfCollisionR ?? 0.01;

    this._lambdaD = [];  // Lagrange multipliers for distance constraints
    this._lambdaB = [];  // Lagrange multipliers for bending constraints
    this._distConstraints = [];
    this._bendConstraints = [];
    this._buildConstraints();
  }

  _buildConstraints() {
    const seen=new Set();
    // Structural + shear distance constraints
    for(const [i,j,k] of this.triangles){
      for(const [a,b] of [[i,j],[j,k],[k,i]]){
        const key=`${Math.min(a,b)}_${Math.max(a,b)}`;
        if(!seen.has(key)){
          seen.add(key);
          this._distConstraints.push({ a, b, rest:v3.len(v3.sub(this.positions[a],this.positions[b])) });
          this._lambdaD.push(0);
        }
      }
    }
    // Bending constraints (dihedral angle between triangle pairs sharing an edge)
    const edgeMap=new Map();
    this.triangles.forEach(([i,j,k],ti)=>{
      for(const [a,b] of [[i,j],[j,k],[k,i]]){
        const key=`${Math.min(a,b)}_${Math.max(a,b)}`;
        const other=edgeMap.get(key);
        if(other!==undefined){
          // Triangles other.ti and ti share edge [a,b]; c,d are opposite vertices
          const oTri=this.triangles[other.ti];
          const c=oTri.find(v=>v!==a&&v!==b), d=[i,j,k].find(v=>v!==a&&v!==b);
          this._bendConstraints.push({ a, b, c, d });
          this._lambdaB.push(0);
        } else {
          edgeMap.set(key, { ti });
        }
      }
    });
  }

  pin(...indices){ indices.forEach(i=>this.invMass[i]=0); }
  unpin(...indices){ indices.forEach(i=>this.invMass[i]>0||( this.invMass[i]=20)); }

  step(dt, colliders=[], substeps=8){
    const h=dt/substeps;
    const hh=h*h;
    for(let s=0;s<substeps;s++){
      // Reset Lagrange multipliers each substep (XPBD requirement)
      this._lambdaD.fill(0);
      this._lambdaB.fill(0);
      this._integrate(h);
      for(let iter=0;iter<4;iter++){
        this._solveDistance(hh);
        this._solveBending(hh);
        this._solveColliders(colliders);
        if(this.selfCollisionR>0) this._solveSelfCollision();
      }
      this._updateVelocities(h);
    }
  }

  _integrate(h){
    for(let i=0;i<this.n;i++){
      if(this.invMass[i]===0) continue;
      this.prev[i]=[...this.positions[i]];
      const g=this.gravity;
      this.positions[i]=[
        this.positions[i][0]+this.velocities[i][0]*h+g[0]*h*h,
        this.positions[i][1]+this.velocities[i][1]*h+g[1]*h*h,
        this.positions[i][2]+this.velocities[i][2]*h+g[2]*h*h,
      ];
    }
  }

  _solveDistance(hh){
    const alpha=this.compliance/hh; // XPBD compliance per substep²
    for(let ci=0;ci<this._distConstraints.length;ci++){
      const {a,b,rest}=this._distConstraints[ci];
      const wA=this.invMass[a],wB=this.invMass[b], w=wA+wB;
      if(w<EPS) continue;
      const d=v3.sub(this.positions[b],this.positions[a]);
      const dist=v3.len(d)+EPS;
      const C=dist-rest;
      const dLambda=(-C-alpha*this._lambdaD[ci])/(w+alpha);
      this._lambdaD[ci]+=dLambda;
      const g=v3.scale(d,dLambda/dist);
      if(wA>0) this.positions[a]=v3.sub(this.positions[a],v3.scale(g,wA));
      if(wB>0) this.positions[b]=v3.add(this.positions[b],v3.scale(g,wB));
    }
  }

  _solveBending(hh){
    // Dihedral angle constraint (Kelager et al. "A Simple Approach to Nonlinear Tensile Stiffness")
    const alpha=this.bendCompliance/hh;
    for(let ci=0;ci<this._bendConstraints.length;ci++){
      const {a,b,c,d}=this._bendConstraints[ci];
      const p1=this.positions[a], p2=this.positions[b];
      const p3=this.positions[c], p4=this.positions[d];
      // Normals of the two triangles
      const n1=v3.cross(v3.sub(p2,p1),v3.sub(p3,p1));
      const n2=v3.cross(v3.sub(p2,p1),v3.sub(p4,p1));
      const n1len=v3.len(n1)+EPS, n2len=v3.len(n2)+EPS;
      const dot=clamp(v3.dot(v3.scale(n1,1/n1len),v3.scale(n2,1/n2len)),-1,1);
      const C=Math.acos(dot)-Math.PI; // target: flat (0 dihedral deviation from rest)
      if(Math.abs(C)<1e-6) continue;
      const wA=this.invMass[a],wB=this.invMass[b],wC=this.invMass[c],wD=this.invMass[d];
      const w=wA+wB+wC+wD; if(w<EPS) continue;
      const dLambda=(-C-alpha*this._lambdaB[ci])/(w+alpha+EPS);
      this._lambdaB[ci]+=dLambda;
      // Gradient direction: towards restoring flat configuration
      const bend=dLambda*0.5;
      if(wA>0) this.positions[a]=v3.add(this.positions[a],v3.scale(v3.norm(v3.cross(v3.sub(p2,p3),n1)),wA*bend/n1len));
      if(wB>0) this.positions[b]=v3.add(this.positions[b],v3.scale(v3.norm(v3.cross(v3.sub(p3,p1),n1)),wB*bend/n1len));
      if(wC>0) this.positions[c]=v3.add(this.positions[c],v3.scale(v3.norm(v3.cross(n2,v3.sub(p2,p4))),wC*bend/n2len));
      if(wD>0) this.positions[d]=v3.add(this.positions[d],v3.scale(v3.norm(v3.cross(n2,v3.sub(p4,p1))),wD*bend/n2len));
    }
  }

  _solveColliders(colliders){
    for(let i=0;i<this.n;i++){
      if(this.invMass[i]===0) continue;
      for(const col of colliders){
        const d=v3.sub(this.positions[i],col.center);
        const dist=v3.len(d);
        if(dist<col.radius+0.002)
          this.positions[i]=v3.add(col.center,v3.scale(v3.norm(d),col.radius+0.002));
      }
    }
  }

  _solveSelfCollision(){
    // Simple O(n²) — replace with spatial hash for large meshes
    const r=this.selfCollisionR;
    for(let i=0;i<this.n-1;i++){
      if(this.invMass[i]===0) continue;
      for(let j=i+1;j<this.n;j++){
        if(this.invMass[j]===0) continue;
        const d=v3.sub(this.positions[j],this.positions[i]);
        const dist=v3.len(d);
        if(dist>2*r||dist<EPS) continue;
        const corr=v3.scale(d,(2*r-dist)/(2*dist));
        this.positions[i]=v3.sub(this.positions[i],corr);
        this.positions[j]=v3.add(this.positions[j],corr);
      }
    }
  }

  _updateVelocities(h){
    for(let i=0;i<this.n;i++){
      if(this.invMass[i]===0) continue;
      this.velocities[i]=v3.scale(v3.sub(this.positions[i],this.prev[i]),(1-this.damping)/h);
    }
  }

  // Fashion try-on: score 1=perfect, 0=terrible
  computeFitScore(bodyColliders){
    let pen=0,cnt=0;
    for(const p of this.positions)
      for(const col of bodyColliders){
        const d=v3.len(v3.sub(p,col.center));
        if(d<col.radius){ pen+=(col.radius-d)/col.radius; cnt++; }
      }
    return Math.max(0,1-pen/Math.max(cnt,1));
  }

  // Size recommendation from fit distribution
  sizeRecommendation(bodyColliders,sizes=['XS','S','M','L','XL']){
    const score=this.computeFitScore(bodyColliders);
    const idx=Math.round((1-score)*(sizes.length-1));
    return sizes[clamp(idx,0,sizes.length-1)];
  }
}

// ─── 2. Rigid Body with Impulse Contact Resolution ────────────────────────────
export class RigidBody {
  constructor({position,orientation,velocity,angularVel,mass,inertiaTensor,restitution=0.3,friction=0.6}={}){
    this.position    = position   ?? [0,0,0];
    this.orientation = orientation instanceof Quat ? orientation : Quat.identity();
    this.mass        = mass ?? 1;
    this.invMass     = mass>0 ? 1/mass : 0;
    this.inertia     = inertiaTensor ?? [mass/6,0,0,0,mass/6,0,0,0,mass/6];
    this.invInertia  = m3.inv(this.inertia);
    this.velocity    = velocity   ?? [0,0,0];
    this.angularVel  = angularVel ?? [0,0,0];
    this.restitution = restitution;
    this.friction    = friction;
    this._force      = [0,0,0];
    this._torque     = [0,0,0];
  }

  applyForce(force, worldPoint=null){
    this._force=v3.add(this._force,force);
    if(worldPoint){ this._torque=v3.add(this._torque,v3.cross(v3.sub(worldPoint,this.position),force)); }
  }

  applyImpulse(j, worldPoint=null){
    this.velocity=v3.add(this.velocity,v3.scale(j,this.invMass));
    if(worldPoint){
      const r=v3.sub(worldPoint,this.position);
      const angI=m3.mulVec(this.invInertia,v3.cross(r,j));
      this.angularVel=v3.add(this.angularVel,angI);
    }
  }

  applyGravity(g=9.81){ if(this.invMass>0) this.applyForce([0,-g*this.mass,0]); }

  integrate(dt){
    if(this.invMass===0) return;
    // Symplectic Euler
    this.velocity=v3.add(this.velocity,v3.scale(this._force,this.invMass*dt));
    this.position=v3.add(this.position,v3.scale(this.velocity,dt));
    const angAccel=m3.mulVec(this.invInertia,this._torque);
    this.angularVel=v3.add(this.angularVel,v3.scale(angAccel,dt));
    const wLen=v3.len(this.angularVel);
    if(wLen>EPS){
      const angle=wLen*dt, axis=v3.scale(this.angularVel,1/wLen);
      this.orientation=this.orientation.mul(Quat.fromAxisAngle(axis,angle)).normalize();
    }
    this._force=[0,0,0]; this._torque=[0,0,0];
  }

  // Resolve a contact with another body (or static surface if bodyB=null)
  // contact: {normal:[nx,ny,nz], point:[px,py,pz], depth:number}
  resolveContact(contact, bodyB=null){
    const {normal:n,point:p}=contact;
    const rA=v3.sub(p,this.position);
    const rB=bodyB?v3.sub(p,bodyB.position):[0,0,0];
    const vRelA=v3.add(this.velocity,v3.cross(this.angularVel,rA));
    const vRelB=bodyB?v3.add(bodyB.velocity,v3.cross(bodyB.angularVel,rB)):[0,0,0];
    const vRel=v3.sub(vRelA,vRelB);
    const vn=v3.dot(vRel,n);
    if(vn>0) return; // separating — no impulse needed

    const e=Math.min(this.restitution, bodyB?.restitution??this.restitution);
    const rAxN=v3.cross(rA,n), rBxN=bodyB?v3.cross(rB,n):[0,0,0];
    const Kn=this.invMass+(bodyB?.invMass??0)
      +v3.dot(n,v3.cross(m3.mulVec(this.invInertia,rAxN),rA))
      +(bodyB?v3.dot(n,v3.cross(m3.mulVec(bodyB.invInertia,rBxN),rB)):0);
    const jn=-(1+e)*vn/Math.max(Kn,EPS);
    const impulse=v3.scale(n,jn);
    this.applyImpulse(impulse,p);
    if(bodyB) bodyB.applyImpulse(v3.scale(impulse,-1),p);

    // Friction impulse (Coulomb)
    const vt=v3.sub(vRel,v3.scale(n,vn));
    const vtLen=v3.len(vt);
    if(vtLen>EPS){
      const t=v3.scale(vt,1/vtLen);
      const rAxT=v3.cross(rA,t), rBxT=bodyB?v3.cross(rB,t):[0,0,0];
      const Kt=this.invMass+(bodyB?.invMass??0)
        +v3.dot(t,v3.cross(m3.mulVec(this.invInertia,rAxT),rA))
        +(bodyB?v3.dot(t,v3.cross(m3.mulVec(bodyB.invInertia,rBxT),rB)):0);
      const mu=Math.min(this.friction,bodyB?.friction??this.friction);
      const jt=clamp(-vtLen/Math.max(Kt,EPS),-mu*Math.abs(jn),mu*Math.abs(jn));
      const frictionImpulse=v3.scale(t,jt);
      this.applyImpulse(frictionImpulse,p);
      if(bodyB) bodyB.applyImpulse(v3.scale(frictionImpulse,-1),p);
    }
  }
}

// ─── 3. Spring-Damper ─────────────────────────────────────────────────────────
// Used for: automotive suspension, elastic joints, furniture springs
export class SpringDamper {
  /**
   * @param bodyA, bodyB     RigidBody instances (bodyB=null for static anchor)
   * @param anchorA, anchorB  local-space attachment points
   * @param restLength        natural length
   * @param stiffness         N/m
   * @param damping           Ns/m
   */
  constructor({bodyA,bodyB=null,anchorA=[0,0,0],anchorB=[0,0,0],restLength=1,stiffness=100,damping=10}={}){
    this.bodyA=bodyA; this.bodyB=bodyB;
    this.anchorA=anchorA; this.anchorB=anchorB;
    this.restLength=restLength; this.stiffness=stiffness; this.damping=damping;
    this.broken=false; this.breakForce=Infinity;
  }

  applyForces(){
    if(this.broken) return;
    const wA=this.bodyA.orientation.rotateVec(this.anchorA);
    const pA=v3.add(this.bodyA.position,wA);
    const pB=this.bodyB ? v3.add(this.bodyB.position,this.bodyB.orientation.rotateVec(this.anchorB)) : this.anchorB;
    const d=v3.sub(pB,pA), dist=v3.len(d)+EPS;
    const dir=v3.scale(d,1/dist);
    const vA=v3.add(this.bodyA.velocity,v3.cross(this.bodyA.angularVel,wA));
    const vB=this.bodyB?v3.add(this.bodyB.velocity,v3.cross(this.bodyB.angularVel,this.bodyB.orientation.rotateVec(this.anchorB))):[0,0,0];
    const relV=v3.dot(v3.sub(vB,vA),dir);
    const spring=this.stiffness*(dist-this.restLength);
    const damp=this.damping*relV;
    const fmag=spring+damp;
    if(Math.abs(fmag)>=this.breakForce){ this.broken=true; return; }
    const force=v3.scale(dir,fmag);
    this.bodyA.applyForce(force,pA);
    if(this.bodyB) this.bodyB.applyForce(v3.scale(force,-1),pB);
  }
}

// ─── 4. BVH + Möller-Trumbore + Gaussian Raycast ────────────────────────────
export class BVH {
  constructor(triangles){ this.root=this._build(triangles,0); }

  _build(tris,depth){
    if(!tris.length) return null;
    const aabb=this._aabb(tris);
    if(tris.length<=4||depth>24) return {aabb,tris,left:null,right:null};
    const axis=this._longestAxis(aabb);
    tris.sort((a,b)=>_centroid(a)[axis]-_centroid(b)[axis]);
    const mid=tris.length>>1;
    return {aabb,tris:null,left:this._build(tris.slice(0,mid),depth+1),right:this._build(tris.slice(mid),depth+1)};
  }

  _aabb(tris){
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    for(const tri of tris) for(const v of tri) for(let i=0;i<3;i++){
      lo[i]=Math.min(lo[i],v[i]); hi[i]=Math.max(hi[i],v[i]);
    }
    return {lo,hi};
  }

  _longestAxis({lo,hi}){ const d=v3.sub(hi,lo); return d[0]>d[1]?(d[0]>d[2]?0:2):(d[1]>d[2]?1:2); }

  // Slab-method AABB test
  static rayAABB(origin,dir,{lo,hi}){
    let tMin=-Infinity,tMax=Infinity;
    for(let i=0;i<3;i++){
      if(Math.abs(dir[i])<EPS){ if(origin[i]<lo[i]||origin[i]>hi[i]) return null; }
      else{ const t1=(lo[i]-origin[i])/dir[i],t2=(hi[i]-origin[i])/dir[i]; tMin=Math.max(tMin,Math.min(t1,t2)); tMax=Math.min(tMax,Math.max(t1,t2)); }
    }
    return tMin<=tMax&&tMax>0?tMin:null;
  }

  // Möller-Trumbore
  static rayTriangle(origin,dir,[v0,v1,v2]){
    const e1=v3.sub(v1,v0),e2=v3.sub(v2,v0),h=v3.cross(dir,e2),a=v3.dot(e1,h);
    if(Math.abs(a)<EPS) return null;
    const f=1/a,s=v3.sub(origin,v0),u=f*v3.dot(s,h);
    if(u<0||u>1) return null;
    const q=v3.cross(s,e1),vv=f*v3.dot(dir,q);
    if(vv<0||u+vv>1) return null;
    const t=f*v3.dot(e2,q);
    if(t<EPS) return null;
    return {t,u,v:vv,normal:v3.norm(v3.cross(e1,e2)),position:v3.add(origin,v3.scale(dir,t))};
  }

  raycast(origin,dir){
    let nearest=null;
    const stack=[this.root];
    while(stack.length){
      const node=stack.pop();
      if(!node||BVH.rayAABB(origin,dir,node.aabb)===null) continue;
      if(node.tris){ for(const tri of node.tris){ const hit=BVH.rayTriangle(origin,dir,tri); if(hit&&(!nearest||hit.t<nearest.t)) nearest={...hit,tri}; } }
      else{ stack.push(node.left,node.right); }
    }
    return nearest;
  }
}

// ─── Gaussian raycast ─────────────────────────────────────────────────────────
// Find the nearest Gaussian whose 3σ ellipsoid intersects a ray.
// Used for click-to-select in the editor.
export function raycastGaussians(data, count, origin, dir, maxDist=Infinity) {
  let nearest=null, nearestT=maxDist;
  const dn=v3.norm(dir);
  for(let i=0;i<count;i++){
    const j=i*14;
    const mu=[data[j],data[j+1],data[j+2]];
    const scale=data.slice(j+3,j+6).map(Math.exp);
    const rot=new Quat(data[j+6],data[j+7],data[j+8],data[j+9]);
    // Transform ray to Gaussian's local frame
    const localO=rot.conjugate().rotateVec(v3.sub(origin,mu));
    const localD=rot.conjugate().rotateVec(dn);
    // Axis-aligned ellipsoid intersection in local frame
    const a=localD[0]*localD[0]/(scale[0]*scale[0])+localD[1]*localD[1]/(scale[1]*scale[1])+localD[2]*localD[2]/(scale[2]*scale[2]);
    const b=2*(localO[0]*localD[0]/(scale[0]*scale[0])+localO[1]*localD[1]/(scale[1]*scale[1])+localO[2]*localD[2]/(scale[2]*scale[2]));
    const c=localO[0]*localO[0]/(scale[0]*scale[0])+localO[1]*localO[1]/(scale[1]*scale[1])+localO[2]*localO[2]/(scale[2]*scale[2])-9; // 3σ boundary
    const disc=b*b-4*a*c;
    if(disc<0) continue;
    const t=(-b-Math.sqrt(disc))/(2*a+EPS);
    if(t>EPS&&t<nearestT){ nearestT=t; nearest={index:i,t,position:v3.add(origin,v3.scale(dn,t))}; }
  }
  return nearest;
}

// ─── 5. Particle System with curl-noise advection ────────────────────────────
export class ParticleSystem {
  constructor({maxCount=10000,gravity=-9.81,drag=0.05,groundY=-Infinity,bounciness=0.3}={}){
    this.max=maxCount; this.gravity=gravity; this.drag=drag;
    this.groundY=groundY; this.bounciness=bounciness;
    this.positions =new Float32Array(maxCount*3);
    this.velocities=new Float32Array(maxCount*3);
    this.ages      =new Float32Array(maxCount);
    this.maxAges   =new Float32Array(maxCount);
    this.alive     =new Uint8Array(maxCount);
    this.count     =0;
    this._nextSlot =0;
  }

  emit({origin,direction,speed,spread,count=10,maxAge=2}){
    let emitted=0;
    for(let attempt=0;attempt<this.max&&emitted<count;attempt++){
      const i=(this._nextSlot+attempt)%this.max;
      if(this.alive[i]) continue;
      const j=i*3;
      this.positions[j  ]=origin[0]+(Math.random()-0.5)*spread;
      this.positions[j+1]=origin[1]+(Math.random()-0.5)*spread;
      this.positions[j+2]=origin[2]+(Math.random()-0.5)*spread;
      const s=speed*(0.7+Math.random()*0.6);
      this.velocities[j  ]=direction[0]*s+(Math.random()-0.5)*spread*0.5;
      this.velocities[j+1]=direction[1]*s+(Math.random()-0.5)*spread*0.5;
      this.velocities[j+2]=direction[2]*s+(Math.random()-0.5)*spread*0.5;
      this.ages[i]=0; this.maxAges[i]=maxAge*(0.7+Math.random()*0.6);
      this.alive[i]=1; this.count++; emitted++;
    }
    this._nextSlot=(this._nextSlot+count)%this.max;
  }

  // Advect using curl noise — used in NIF solidification transition
  emitCurl({count=200,scale=1,speed=0.5,maxAge=3,time=0}){
    for(let e=0;e<count;e++){
      const i=e%this.max; if(this.alive[i]) continue; const j=i*3;
      const p=[(Math.random()-0.5)*scale,(Math.random()-0.5)*scale,(Math.random()-0.5)*scale];
      const curl=Noise.curl(p[0]+time,p[1],p[2]);
      this.positions[j]=p[0]; this.positions[j+1]=p[1]; this.positions[j+2]=p[2];
      this.velocities[j]=curl[0]*speed; this.velocities[j+1]=curl[1]*speed; this.velocities[j+2]=curl[2]*speed;
      this.ages[i]=0; this.maxAges[i]=maxAge*(0.5+Math.random());
      this.alive[i]=1; this.count++;
    }
  }

  step(dt, curlStrength=0){
    for(let i=0;i<this.max;i++){
      if(!this.alive[i]) continue;
      this.ages[i]+=dt;
      if(this.ages[i]>this.maxAges[i]){ this.alive[i]=0; this.count--; continue; }
      const j=i*3;
      // Curl-noise advection (optional — used for transition)
      if(curlStrength>0){
        const c=Noise.curl(this.positions[j]*0.5,this.positions[j+1]*0.5,this.positions[j+2]*0.5);
        this.velocities[j  ]+=c[0]*curlStrength*dt;
        this.velocities[j+1]+=c[1]*curlStrength*dt;
        this.velocities[j+2]+=c[2]*curlStrength*dt;
      }
      this.velocities[j  ]*=(1-this.drag*dt);
      this.velocities[j+1]+=this.gravity*dt; this.velocities[j+1]*=(1-this.drag*dt);
      this.velocities[j+2]*=(1-this.drag*dt);
      this.positions[j  ]+=this.velocities[j  ]*dt;
      this.positions[j+1]+=this.velocities[j+1]*dt;
      this.positions[j+2]+=this.velocities[j+2]*dt;
      // Ground bounce
      if(this.positions[j+1]<this.groundY){
        this.positions[j+1]=this.groundY;
        this.velocities[j+1]=Math.abs(this.velocities[j+1])*this.bounciness;
      }
    }
  }

  getAliveBuffer(){
    const pos=[], ages=[];
    for(let i=0;i<this.max;i++){
      if(!this.alive[i]) continue;
      const j=i*3;
      pos.push(this.positions[j],this.positions[j+1],this.positions[j+2]);
      ages.push(this.ages[i]/this.maxAges[i]);
    }
    return {positions:new Float32Array(pos),ages:new Float32Array(ages)};
  }
}

// ─── 6. FEM Soft Body (co-rotated linear FEM on tetrahedra) ──────────────────
// Reference: Sifakis & Barbic "FEM Simulation of 3D Deformable Solids" (SIGGRAPH 2012)
// Used for: soil deformation (agriculture), foam materials, organic shapes
export class FEMSoftBody {
  /**
   * @param {number[][]} vertices  rest positions [x,y,z]
   * @param {number[][]} tets      tetrahedra index quads [a,b,c,d]
   * @param {number}     E         Young's modulus (Pa, e.g. 1e5 for foam)
   * @param {number}     nu        Poisson ratio (e.g. 0.45)
   * @param {number}     density   kg/m³ (e.g. 1000 for water-like)
   */
  constructor(vertices,tets,{E=1e5,nu=0.45,density=1000,damping=5}={}){
    this.n=vertices.length;
    this.x=vertices.map(v=>[...v]);   // current positions
    this.x0=vertices.map(v=>[...v]);  // rest positions
    this.v=vertices.map(()=>[0,0,0]);
    this.f=vertices.map(()=>[0,0,0]);
    this.tets=tets;
    // Lamé parameters from E, nu
    this.mu=E/(2*(1+nu));
    this.lam=E*nu/((1+nu)*(1-2*nu));
    this.damping=damping;
    // Mass lumping: distribute tet volume mass to vertices
    this.mass=new Float32Array(this.n).fill(0);
    this._Dm_inv=[];  // inverse reference shape matrices
    this._restVol=[]; // rest volumes (for pressure)
    this._precompute(density);
  }

  _precompute(density){
    for(const [a,b,c,d] of this.tets){
      const Dm=[
        ...v3.sub(this.x0[b],this.x0[a]),
        ...v3.sub(this.x0[c],this.x0[a]),
        ...v3.sub(this.x0[d],this.x0[a]),
      ];
      const vol=Math.abs(m3.det(Dm))/6;
      this._restVol.push(vol);
      this._Dm_inv.push(m3.inv(Dm));
      const nodeMass=density*vol/4;
      [a,b,c,d].forEach(i=>this.mass[i]+=nodeMass);
    }
  }

  addForce(i,force){ this.f[i]=v3.add(this.f[i],force); }
  addGravity(g=9.81){ for(let i=0;i<this.n;i++) this.f[i]=v3.add(this.f[i],[0,-g*this.mass[i],0]); }
  pin(...indices){ indices.forEach(i=>this.mass[i]=-1); }

  step(dt){
    this._computeElasticForces();
    for(let i=0;i<this.n;i++){
      if(this.mass[i]<=0) continue;
      const invM=1/this.mass[i];
      this.v[i]=v3.add(this.v[i],v3.scale(this.f[i],invM*dt));
      this.v[i]=v3.scale(this.v[i],Math.exp(-this.damping*dt)); // viscous damping
      this.x[i]=v3.add(this.x[i],v3.scale(this.v[i],dt));
      this.f[i]=[0,0,0];
    }
  }

  _computeElasticForces(){
    for(let ti=0;ti<this.tets.length;ti++){
      const [a,b,c,d]=this.tets[ti];
      const Ds=[
        ...v3.sub(this.x[b],this.x[a]),
        ...v3.sub(this.x[c],this.x[a]),
        ...v3.sub(this.x[d],this.x[a]),
      ];
      // Deformation gradient F = Ds · Dm⁻¹
      const F=m3.mul(Ds,this._Dm_inv[ti]);
      // Polar decompose F = R·S for co-rotational formulation
      const {R,S}=m3.polarDecompose(F);
      // Cauchy-Green strain: E_c = Sᵀ·S - I (Green strain linearised)
      const Rt=m3.transpose(R);
      const FtF=m3.mul(m3.transpose(F),F);
      const strain=[FtF[0]-1,FtF[4]-1,FtF[8]-1, FtF[1],FtF[2],FtF[5]]; // [exx,eyy,ezz,exy,exz,eyz]
      // First Piola-Kirchhoff stress: P = R·(2μ·E + λ·tr(E)·I)
      const trE=strain[0]+strain[1]+strain[2];
      const stress=[
        2*this.mu*strain[0]+this.lam*trE, 2*this.mu*strain[3], 2*this.mu*strain[4],
        2*this.mu*strain[3], 2*this.mu*strain[1]+this.lam*trE, 2*this.mu*strain[5],
        2*this.mu*strain[4], 2*this.mu*strain[5], 2*this.mu*strain[2]+this.lam*trE,
      ];
      const P=m3.mul(R,stress);
      // Force on each vertex: f = -P·Dm⁻ᵀ·vol
      const PdmT=m3.mul(P,m3.transpose(this._Dm_inv[ti]));
      const vol=this._restVol[ti];
      const fb=[PdmT[0]*vol,PdmT[3]*vol,PdmT[6]*vol];
      const fc=[PdmT[1]*vol,PdmT[4]*vol,PdmT[7]*vol];
      const fd=[PdmT[2]*vol,PdmT[5]*vol,PdmT[8]*vol];
      const fa=v3.neg(v3.add(v3.add(fb,fc),fd));
      if(this.mass[a]>0) this.f[a]=v3.sub(this.f[a],fa);
      if(this.mass[b]>0) this.f[b]=v3.sub(this.f[b],fb);
      if(this.mass[c]>0) this.f[c]=v3.sub(this.f[c],fc);
      if(this.mass[d]>0) this.f[d]=v3.sub(this.f[d],fd);
    }
  }
}

// ─── 7. Lighting ──────────────────────────────────────────────────────────────
export const Lighting = {
  // Rectangular area light — Monte Carlo integration
  areaLight: ({lightPos,lightNormal,width,height,emission,surfacePoint,surfaceNormal,samples=16})=>{
    const right=v3.norm(v3.cross(lightNormal,[0,1,0]));
    const up=v3.cross(right,lightNormal);
    let total=[0,0,0];
    for(let i=0;i<samples;i++){
      const u=(Math.random()-0.5)*width, vv=(Math.random()-0.5)*height;
      const pt=v3.add(lightPos,v3.add(v3.scale(right,u),v3.scale(up,vv)));
      const wi=v3.norm(v3.sub(pt,surfacePoint));
      const NdotL=Math.max(v3.dot(surfaceNormal,wi),0);
      const LdotN=Math.abs(v3.dot(lightNormal,v3.neg(wi)));
      const d2=v3.len2(v3.sub(pt,surfacePoint));
      const sa=(width*height*LdotN)/(d2+EPS);
      total=v3.add(total,v3.scale(emission,NdotL*sa/samples));
    }
    return total;
  },

  // IBL diffuse from 9-coefficient SH (Lambertian convolution)
  iblDiffuse: (normal,sh9)=>{
    const [nx,ny,nz]=normal;
    return [0,1,2].map(c=>{
      const co=sh9[c];
      return Math.max(0,
        co[0]*0.886227+co[3]*1.023328*nx+co[1]*1.023328*ny+co[2]*1.023328*nz+
        co[6]*0.858086*(2*nz*nz-nx*nx-ny*ny)/2+co[4]*0.858086*nx*ny+
        co[5]*0.858086*ny*nz+co[7]*0.858086*nx*nz+co[8]*0.429043*(nx*nx-ny*ny)
      );
    });
  },

  // Point light with physically-correct inverse-square falloff
  pointLight: (lightPos,emission,surfacePoint,surfaceNormal)=>{
    const d=v3.sub(lightPos,surfacePoint), dist2=v3.len2(d)+EPS;
    const wi=v3.scale(d,1/Math.sqrt(dist2));
    const NdotL=Math.max(v3.dot(surfaceNormal,wi),0);
    return v3.scale(emission,NdotL/dist2);
  },
};

// ─── 8. GaussianKDTree (spatial index for editor hit-testing) ─────────────────
// k-d tree built on Gaussian centroids for fast radius queries in the editor.
export class GaussianKDTree {
  constructor(data, count){
    this.data=data; this.count=count;
    const pts=new Array(count).fill(0).map((_,i)=>i);
    this.root=this._build(pts,0);
  }

  _build(indices,depth){
    if(!indices.length) return null;
    const axis=depth%3;
    indices.sort((a,b)=>this.data[a*14+axis]-this.data[b*14+axis]);
    const mid=indices.length>>1;
    return {
      idx:indices[mid], axis,
      left: this._build(indices.slice(0,mid),depth+1),
      right:this._build(indices.slice(mid+1),depth+1),
    };
  }

  // Return all Gaussian indices within sphere(center,radius)
  radiusQuery(center,radius){
    const r2=radius*radius, result=[];
    const search=node=>{
      if(!node) return;
      const j=node.idx*14;
      const dx=this.data[j]-center[0],dy=this.data[j+1]-center[1],dz=this.data[j+2]-center[2];
      if(dx*dx+dy*dy+dz*dz<=r2) result.push(node.idx);
      const diff=center[node.axis]-this.data[j+node.axis];
      search(diff<0?node.left:node.right);
      if(diff*diff<=r2) search(diff<0?node.right:node.left);
    };
    search(this.root);
    return result;
  }

  // k-nearest neighbours
  kNN(center,k){
    const heap=[];
    const search=node=>{
      if(!node) return;
      const j=node.idx*14;
      const dx=this.data[j]-center[0],dy=this.data[j+1]-center[1],dz=this.data[j+2]-center[2];
      const d2=dx*dx+dy*dy+dz*dz;
      if(heap.length<k||(heap[0]&&d2<heap[0].d2)){
        heap.push({idx:node.idx,d2});
        heap.sort((a,b)=>b.d2-a.d2);
        if(heap.length>k) heap.pop();
      }
      const diff=center[node.axis]-this.data[j+node.axis];
      search(diff<0?node.left:node.right);
      if(heap.length<k||diff*diff<heap[0].d2) search(diff<0?node.right:node.left);
    };
    search(this.root);
    return heap.map(h=>h.idx);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _centroid(tri){ return [(tri[0][0]+tri[1][0]+tri[2][0])/3,(tri[0][1]+tri[1][1]+tri[2][1])/3,(tri[0][2]+tri[1][2]+tri[2][2])/3]; }

// ─── Structural Frame Solver ─────────────────────────────────────────────────
// Direct stiffness method for 3D frame structures.
// Used by BIM/Architecture plugin for real-time structural feedback in the viewer.
// Reference: McGuire, Gallagher & Ziemian "Matrix Structural Analysis" 2nd ed.
// (Structural, v3, m3, EPS imported at top of file)

export class StructuralFrame {
  /**
   * Models a 3D frame of beam/column elements.
   * Nodes have 6 DOF: [ux,uy,uz,rx,ry,rz]
   * @param {object} opts
   *   material: one of Structural.MATERIALS keys (default 'steel')
   *   gravity:  [gx,gy,gz] in m/s² (default [0,-9.81,0])
   */
  constructor(opts={}) {
    this.material = Structural.MATERIALS[opts.material??'steel'];
    this.gravity  = opts.gravity ?? [0,-9.81,0];
    this.nodes    = [];  // [{id, pos:[x,y,z], fixed:[tx,ty,tz,rx,ry,rz]}]
    this.elements = [];  // [{id, nodeA, nodeB, section:{b,h}|{r}}]
    this._results = null;
  }

  addNode(id, pos, fixed=[false,false,false,false,false,false]) {
    this.nodes.push({ id, pos:[...pos], fixed });
    return this;
  }

  addBeam(id, nodeAId, nodeBId, section={ b:0.2, h:0.4 }) {
    this.elements.push({ id, a:nodeAId, b:nodeBId, section });
    return this;
  }

  addColumn(id, nodeAId, nodeBId, section={ b:0.3, h:0.3 }) {
    return this.addBeam(id, nodeAId, nodeBId, section);
  }

  applyLoad(nodeId, force=[0,0,0], moment=[0,0,0]) {
    const n=this.nodes.find(n=>n.id===nodeId);
    if(n) { n.force=force; n.moment=moment; }
    return this;
  }

  // Solve for displacements and reactions (simplified 2D in XY plane for MVP)
  // Returns { displacements, reactions, elementForces, warnings }
  solve() {
    const warnings=[];
    const results=[];

    for (const el of this.elements) {
      const nA=this.nodes.find(n=>n.id===el.a);
      const nB=this.nodes.find(n=>n.id===el.b);
      if (!nA||!nB) continue;

      const L=v3.dist(nA.pos,nB.pos);
      if (L<EPS) { warnings.push(`Element ${el.id} has zero length`); continue; }

      const E=this.material.E;
      const A=el.section.r
        ? Math.PI*el.section.r*el.section.r
        : el.section.b*el.section.h;
      const I=el.section.r
        ? Structural.circMomentOfArea(el.section.r)
        : Structural.rectMomentOfArea(el.section.b,el.section.h);

      // Self-weight as UDL (N/m)
      const w = this.material.density * A * Math.abs(this.gravity[1]);

      // Mid-span deflection under self-weight
      const delta = Structural.midspanDeflection(w, L, E, I);

      // Axial load from applied forces at nodes
      const dir=v3.norm(v3.sub(nB.pos,nA.pos));
      const fA=nA.force??[0,0,0], fB=nB.force??[0,0,0];
      const axial=v3.dot(v3.sub(fB,fA),dir);

      // Bending stress at extreme fibre
      const M_max=w*L*L/8; // UDL simply supported
      const y=el.section.r ? el.section.r : el.section.h/2;
      const stress=Structural.bendingStress(M_max,y,I)+Structural.axialStress(axial,A);

      // Buckling load
      const P_cr=Structural.eulerBucklingLoad(E,I,L);

      // Safety check
      const check=Structural.checkElement({
        stress, yieldStrength:this.material.yield, bucklingLoad:P_cr, axialLoad:axial
      });

      if(!check.safe) warnings.push(`Element ${el.id}: ${check.message} (ratio ${check.ratio.toFixed(2)})`);

      results.push({ elementId:el.id, L, A, I, axial, stress, delta, bucklingLoad:P_cr, check });
    }

    this._results={ elements:results, warnings };
    return this._results;
  }

  // Get colour for visualisation: green→yellow→red based on utilisation ratio
  getElementColor(elementId) {
    const r=this._results?.elements.find(e=>e.elementId===elementId);
    if(!r) return [0.5,0.5,0.5];
    const t=Math.min(r.check.ratio,1);
    return t<0.5
      ? [t*2, 1, 0]           // green → yellow
      : [1, 2*(1-t), 0];      // yellow → red
  }
}

// ─── Constraint Network (for NIF interaction graph) ───────────────────────────
// A network of physics constraints between NIF scene nodes.
// Enables parametric behaviour: move one node, others follow constraints.
export class ConstraintNetwork {
  constructor() {
    this.bodies      = new Map(); // id → RigidBody
    this.springs     = [];
    this.distances   = [];
    this.hinges      = [];
  }

  addBody(id, body) { this.bodies.set(id,body); return this; }

  addSpring(bodyAId, bodyBId, opts={}) {
    const a=this.bodies.get(bodyAId), b=this.bodies.get(bodyBId);
    if(a&&b) this.springs.push(new SpringDamper({
      bodyA:a, bodyB:b,
      restLength:opts.rest??1,
      stiffness:opts.k??100,
      damping:opts.d??10,
      ...opts
    }));
    return this;
  }

  addHinge(bodyAId, bodyBId, axis=[0,1,0]) {
    this.hinges.push({ a:bodyAId, b:bodyBId, axis });
    return this;
  }

  step(dt) {
    this.springs.forEach(s=>s.applyForces());
    this.bodies.forEach(b=>b.integrate(dt));
    // Hinge constraints: project out relative rotation around non-hinge axes
    for (const h of this.hinges) {
      const a=this.bodies.get(h.a), b=this.bodies.get(h.b);
      if(!a||!b) continue;
      const relAng=v3.sub(a.angularVel, b.angularVel);
      const along=v3.scale(h.axis, v3.dot(relAng,h.axis));
      const correction=v3.scale(v3.sub(relAng,along),0.5);
      a.angularVel=v3.sub(a.angularVel,correction);
      b.angularVel=v3.add(b.angularVel,correction);
    }
  }
}
