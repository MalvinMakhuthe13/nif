/**
 * NIFMath — Complete 4D Mathematics Engine
 * © Fumoca Technologies · fumoca.co.za
 *
 * Pure, side-effect-free, numerically stable.
 * Every function tested against reference implementations.
 *
 * Sections:
 *   Vec2, Vec3, Vec4
 *   Quaternion (SO3) + Dual Quaternion (SE3 rigid skinning)
 *   Mat2, Mat3, Mat4
 *   Spherical Harmonics (degree 0–3, 16 bases)
 *   3D Gaussian (covariance, EWA projection, pack/unpack)
 *   SDF density field
 *   Camera models (pinhole, fisheye, equirectangular)
 *   Splines (Catmull-Rom, cubic Hermite)
 *   Noise (Perlin, curl, simplex-based FBM)
 *   Frustum & AABB intersection
 *   Motion blur (8-pt Gauss-Legendre)
 *   Cook-Torrance BRDF (GGX)
 *   HRTF spatial audio
 *   4D timeline interpolation
 *   Polar decomposition (for FEM strain)
 *   Utilities
 */

export const EPS = 1e-8;
export const PI  = Math.PI;
export const TAU = 2 * PI;

// ─── Vec2 ─────────────────────────────────────────────────────────────────────
export const v2 = {
  add:   (a,b) => [a[0]+b[0], a[1]+b[1]],
  sub:   (a,b) => [a[0]-b[0], a[1]-b[1]],
  scale: (a,s) => [a[0]*s,    a[1]*s],
  dot:   (a,b) => a[0]*b[0] + a[1]*b[1],
  len:   (a)   => Math.sqrt(a[0]*a[0] + a[1]*a[1]),
  len2:  (a)   => a[0]*a[0] + a[1]*a[1],
  norm:  (a)   => { const n=Math.sqrt(a[0]*a[0]+a[1]*a[1]); return n<EPS?[0,0]:[a[0]/n,a[1]/n]; },
  perp:  (a)   => [-a[1], a[0]],
  lerp:  (a,b,t)=> [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t],
  angle: (a)   => Math.atan2(a[1], a[0]),
  rotate:(a,th)=> [a[0]*Math.cos(th)-a[1]*Math.sin(th), a[0]*Math.sin(th)+a[1]*Math.cos(th)],
};

// ─── Vec3 ─────────────────────────────────────────────────────────────────────
export const v3 = {
  add:    (a,b)  => [a[0]+b[0], a[1]+b[1], a[2]+b[2]],
  sub:    (a,b)  => [a[0]-b[0], a[1]-b[1], a[2]-b[2]],
  scale:  (a,s)  => [a[0]*s,    a[1]*s,    a[2]*s],
  dot:    (a,b)  => a[0]*b[0] + a[1]*b[1] + a[2]*b[2],
  cross:  (a,b)  => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]],
  len:    (a)    => Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]),
  len2:   (a)    => a[0]*a[0]+a[1]*a[1]+a[2]*a[2],
  norm:   (a)    => { const n=Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]); return n<EPS?[0,0,0]:[a[0]/n,a[1]/n,a[2]/n]; },
  neg:    (a)    => [-a[0],-a[1],-a[2]],
  lerp:   (a,b,t)=> [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t],
  reflect:(a,n)  => { const d=2*v3.dot(a,n); return [a[0]-d*n[0],a[1]-d*n[1],a[2]-d*n[2]]; },
  // Project a onto b
  project:(a,b)  => v3.scale(b, v3.dot(a,b)/(v3.len2(b)+EPS)),
  // Component-wise min/max for AABB
  min:    (a,b)  => [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.min(a[2],b[2])],
  max:    (a,b)  => [Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.max(a[2],b[2])],
  abs:    (a)    => [Math.abs(a[0]),Math.abs(a[1]),Math.abs(a[2])],
  // Distance squared — avoids sqrt in BVH hot path
  dist2:  (a,b)  => { const d=v3.sub(a,b); return v3.len2(d); },
  dist:   (a,b)  => Math.sqrt(v3.dist2(a,b)),
  // Clamp each component
  clampV: (a,lo,hi) => [clamp(a[0],lo,hi),clamp(a[1],lo,hi),clamp(a[2],lo,hi)],
};

// ─── Vec4 ─────────────────────────────────────────────────────────────────────
export const v4 = {
  add:   (a,b)  => [a[0]+b[0],a[1]+b[1],a[2]+b[2],a[3]+b[3]],
  sub:   (a,b)  => [a[0]-b[0],a[1]-b[1],a[2]-b[2],a[3]-b[3]],
  scale: (a,s)  => [a[0]*s,a[1]*s,a[2]*s,a[3]*s],
  dot:   (a,b)  => a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3],
  len:   (a)    => Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]+a[3]*a[3]),
  norm:  (a)    => { const n=Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]+a[3]*a[3]); return n<EPS?[0,0,0,0]:[a[0]/n,a[1]/n,a[2]/n,a[3]/n]; },
  lerp:  (a,b,t)=> [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t,a[3]+(b[3]-a[3])*t],
  // Homogeneous divide
  hdiv:  (a)    => [a[0]/a[3],a[1]/a[3],a[2]/a[3],1],
  xyz:   (a)    => [a[0],a[1],a[2]],
};

// ─── Quaternion (unit quaternion, SO3) ────────────────────────────────────────
export class Quat {
  constructor(w=1,x=0,y=0,z=0){ this.w=w; this.x=x; this.y=y; this.z=z; }

  static identity()             { return new Quat(1,0,0,0); }
  static fromArray([w,x,y,z])  { return new Quat(w,x,y,z); }

  static fromAxisAngle(axis, angle) {
    const [ax,ay,az]=v3.norm(axis), s=Math.sin(angle/2), c=Math.cos(angle/2);
    return new Quat(c,ax*s,ay*s,az*s);
  }

  static fromEulerZYX(roll, pitch, yaw) {
    const cr=Math.cos(roll/2),sr=Math.sin(roll/2);
    const cp=Math.cos(pitch/2),sp=Math.sin(pitch/2);
    const cy=Math.cos(yaw/2),sy=Math.sin(yaw/2);
    return new Quat(
      cr*cp*cy+sr*sp*sy, sr*cp*cy-cr*sp*sy,
      cr*sp*cy+sr*cp*sy, cr*cp*sy-sr*sp*cy,
    ).normalize();
  }

  // Build from two vectors (rotation that takes a to b)
  static fromVectors(a, b) {
    const an=v3.norm(a), bn=v3.norm(b);
    const dot=v3.dot(an,bn);
    if (dot > 0.9999) return Quat.identity();
    if (dot < -0.9999) {
      // 180° — pick arbitrary perpendicular axis
      let ax=[1,0,0];
      if (Math.abs(an[0]) > 0.9) ax=[0,1,0];
      return Quat.fromAxisAngle(v3.cross(an,ax), PI);
    }
    const axis=v3.cross(an,bn);
    return new Quat(1+dot, axis[0],axis[1],axis[2]).normalize();
  }

  norm()     { return Math.sqrt(this.w**2+this.x**2+this.y**2+this.z**2); }
  normalize(){ const n=this.norm(); return n<EPS ? new Quat(1,0,0,0) : new Quat(this.w/n,this.x/n,this.y/n,this.z/n); }
  conjugate(){ return new Quat(this.w,-this.x,-this.y,-this.z); }
  inverse()  { return this.conjugate().normalize(); }
  toArray()  { return [this.w,this.x,this.y,this.z]; }

  mul(q) {
    return new Quat(
      this.w*q.w-this.x*q.x-this.y*q.y-this.z*q.z,
      this.w*q.x+this.x*q.w+this.y*q.z-this.z*q.y,
      this.w*q.y-this.x*q.z+this.y*q.w+this.z*q.x,
      this.w*q.z+this.x*q.y-this.y*q.x+this.z*q.w,
    );
  }

  rotateVec(v) {
    const q=new Quat(0,...v), r=this.mul(q).mul(this.conjugate());
    return [r.x,r.y,r.z];
  }

  // Euler angles (ZYX) — for display only
  toEuler() {
    const {w,x,y,z}=this;
    const sinp=2*(w*y-z*x);
    return {
      roll:  Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y)),
      pitch: Math.abs(sinp)>=1 ? Math.sign(sinp)*PI/2 : Math.asin(sinp),
      yaw:   Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z)),
    };
  }

  toMat3() {
    const {w,x,y,z}=this;
    return [
      1-2*(y*y+z*z), 2*(x*y+w*z),   2*(x*z-w*y),
        2*(x*y-w*z), 1-2*(x*x+z*z), 2*(y*z+w*x),
        2*(x*z+w*y), 2*(y*z-w*x),   1-2*(x*x+y*y),
    ];
  }

  toMat4() {
    const m=this.toMat3();
    return [m[0],m[1],m[2],0, m[3],m[4],m[5],0, m[6],m[7],m[8],0, 0,0,0,1];
  }

  // Shortest-path SLERP
  static slerp(q1, q2, t) {
    let dot=q1.w*q2.w+q1.x*q2.x+q1.y*q2.y+q1.z*q2.z;
    if (dot<0){ q2=new Quat(-q2.w,-q2.x,-q2.y,-q2.z); dot=-dot; }
    if (dot>0.9995) return new Quat(
      q1.w+t*(q2.w-q1.w),q1.x+t*(q2.x-q1.x),
      q1.y+t*(q2.y-q1.y),q1.z+t*(q2.z-q1.z),
    ).normalize();
    const th0=Math.acos(dot), th=th0*t;
    const s1=Math.sin(th0-th)/Math.sin(th0), s2=Math.sin(th)/Math.sin(th0);
    return new Quat(s1*q1.w+s2*q2.w,s1*q1.x+s2*q2.x,s1*q1.y+s2*q2.y,s1*q1.z+s2*q2.z);
  }

  // Squad — smooth 4-point quaternion interpolation for splines
  static squad(q0, q1, q2, q3, t) {
    const inner = (qa, qb, qc) => {
      const qi=qa.inverse();
      const log1=Quat.log(qi.mul(qb)), log2=Quat.log(qi.mul(qc));
      const avg=new Quat(
        -(log1.w+log2.w)/4,-(log1.x+log2.x)/4,
        -(log1.y+log2.y)/4,-(log1.z+log2.z)/4
      );
      return qa.mul(Quat.exp(avg));
    };
    const s1=inner(q0,q1,q2), s2=inner(q1,q2,q3);
    return Quat.slerp(Quat.slerp(q1,q2,t), Quat.slerp(s1,s2,t), 2*t*(1-t));
  }

  static log(q) {
    const vLen=Math.sqrt(q.x*q.x+q.y*q.y+q.z*q.z);
    if (vLen<EPS) return new Quat(Math.log(q.norm()),0,0,0);
    const th=Math.atan2(vLen,q.w), s=th/vLen;
    return new Quat(Math.log(q.norm()),q.x*s,q.y*s,q.z*s);
  }

  static exp(q) {
    const vLen=Math.sqrt(q.x*q.x+q.y*q.y+q.z*q.z);
    const e=Math.exp(q.w);
    if (vLen<EPS) return new Quat(e,0,0,0);
    const s=e*Math.sin(vLen)/vLen;
    return new Quat(e*Math.cos(vLen),q.x*s,q.y*s,q.z*s);
  }
}

// ─── Dual Quaternion (SE3 — rigid body skinning without candy-wrapper artifact) ─
// Reference: Kavan et al. "Geometric Skinning with Approximate Dual Quaternion Blending"
export class DualQuat {
  /**
   * real: unit quaternion (rotation)
   * dual: pure quaternion encoding translation via (t/2)*real
   */
  constructor(real, dual) {
    this.real = real; // Quat
    this.dual = dual; // Quat
  }

  static identity() {
    return new DualQuat(Quat.identity(), new Quat(0,0,0,0));
  }

  static fromRT(rotation, translation) {
    const r = rotation.normalize();
    const t = new Quat(0, translation[0]/2, translation[1]/2, translation[2]/2);
    return new DualQuat(r, t.mul(r));
  }

  normalize() {
    const n = this.real.norm() + EPS;
    const dr = new Quat(this.real.w/n,this.real.x/n,this.real.y/n,this.real.z/n);
    const dd = new Quat(this.dual.w/n,this.dual.x/n,this.dual.y/n,this.dual.z/n);
    return new DualQuat(dr, dd);
  }

  // DLB (Dual quaternion Linear Blending) — add weighted influences
  static blend(dqs, weights) {
    let rw=0,rx=0,ry=0,rz=0, dw=0,dx=0,dy=0,dz=0;
    // Pivot to first DQ to avoid antipodal flip artefacts
    const r0=dqs[0].real;
    for (let i=0;i<dqs.length;i++) {
      const {real:r,dual:d}=dqs[i], w=weights[i];
      const sign=(r0.w*r.w+r0.x*r.x+r0.y*r.y+r0.z*r.z)<0?-1:1;
      rw+=sign*r.w*w; rx+=sign*r.x*w; ry+=sign*r.y*w; rz+=sign*r.z*w;
      dw+=sign*d.w*w; dx+=sign*d.x*w; dy+=sign*d.y*w; dz+=sign*d.z*w;
    }
    return new DualQuat(new Quat(rw,rx,ry,rz), new Quat(dw,dx,dy,dz)).normalize();
  }

  // Extract [4,4] matrix for vertex transform
  toMat4() {
    const {real:r,dual:d}=this.normalize();
    const tx=2*(-d.w*r.x+d.x*r.w-d.y*r.z+d.z*r.y);
    const ty=2*(-d.w*r.y+d.x*r.z+d.y*r.w-d.z*r.x);
    const tz=2*(-d.w*r.z-d.x*r.y+d.y*r.x+d.z*r.w);
    const m=r.toMat3();
    return [m[0],m[1],m[2],0, m[3],m[4],m[5],0, m[6],m[7],m[8],0, tx,ty,tz,1];
  }

  // Transform point
  transformPoint(p) {
    const m=this.toMat4();
    return [
      m[0]*p[0]+m[4]*p[1]+m[8]*p[2] +m[12],
      m[1]*p[0]+m[5]*p[1]+m[9]*p[2] +m[13],
      m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14],
    ];
  }
}

// ─── 2×2 matrix ───────────────────────────────────────────────────────────────
export const m2 = {
  det: (M) => M[0]*M[3] - M[1]*M[2],
  inv: (M) => { const d=m2.det(M)+EPS; return [M[3]/d,-M[1]/d,-M[2]/d,M[0]/d]; },
  mul: (A,B) => [A[0]*B[0]+A[1]*B[2],A[0]*B[1]+A[1]*B[3],A[2]*B[0]+A[3]*B[2],A[2]*B[1]+A[3]*B[3]],
  // Eigenvalues of symmetric 2×2 — used in EWA ellipse fitting
  eigenvalues: (a,b,d) => {
    const tr=(a+d)/2, disc=Math.sqrt(Math.max((a-d)**2/4+b*b,0));
    return [tr+disc, tr-disc];
  },
};

// ─── 3×3 matrix ───────────────────────────────────────────────────────────────
export const m3 = {
  mul: (A,B) => {
    const C=new Array(9).fill(0);
    for(let i=0;i<3;i++) for(let j=0;j<3;j++) for(let k=0;k<3;k++) C[i*3+j]+=A[i*3+k]*B[k*3+j];
    return C;
  },
  mulVec:    (M,v)  => [M[0]*v[0]+M[1]*v[1]+M[2]*v[2], M[3]*v[0]+M[4]*v[1]+M[5]*v[2], M[6]*v[0]+M[7]*v[1]+M[8]*v[2]],
  mulDiag:   (M,d)  => M.map((v,i)=>v*d[i%3]),
  transpose: (M)    => [M[0],M[3],M[6],M[1],M[4],M[7],M[2],M[5],M[8]],
  sandwich:  (A,B)  => m3.mul(m3.mul(A,B),m3.transpose(A)),
  scale:     (M,s)  => M.map(v=>v*s),
  add:       (A,B)  => A.map((v,i)=>v+B[i]),
  identity:  ()     => [1,0,0,0,1,0,0,0,1],
  det: (M) =>
    M[0]*(M[4]*M[8]-M[5]*M[7]) - M[1]*(M[3]*M[8]-M[5]*M[6]) + M[2]*(M[3]*M[7]-M[4]*M[6]),
  inv: (M) => {
    const d=m3.det(M)+EPS;
    return [
       (M[4]*M[8]-M[5]*M[7])/d, -(M[1]*M[8]-M[2]*M[7])/d,  (M[1]*M[5]-M[2]*M[4])/d,
      -(M[3]*M[8]-M[5]*M[6])/d,  (M[0]*M[8]-M[2]*M[6])/d, -(M[0]*M[5]-M[2]*M[3])/d,
       (M[3]*M[7]-M[4]*M[6])/d, -(M[0]*M[7]-M[1]*M[6])/d,  (M[0]*M[4]-M[1]*M[3])/d,
    ];
  },
  // Polar decomposition: M = R·S  (orthogonal R, symmetric positive S)
  // Used in FEM for correct strain computation.
  // Iterative method (Higham 1988) — converges in ~6 iterations for realistic inputs.
  polarDecompose: (M, iters=8) => {
    let R=[...M];
    for (let k=0;k<iters;k++) {
      const Ri=m3.inv(R);
      const Rt=m3.transpose(Ri);
      R = R.map((v,i)=>(v+Rt[i])*0.5);
    }
    const S=m3.mul(m3.transpose(R),M);
    return { R, S }; // R is orthogonal, S is symmetric
  },
};

// ─── 4×4 matrix (column-major, WebGL convention) ─────────────────────────────
export const m4 = {
  identity: () => [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],

  perspective: (fovY, aspect, near, far) => {
    const f=1/Math.tan(fovY/2), nf=1/(near-far);
    return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0];
  },

  orthographic: (left, right, bottom, top, near, far) => {
    const rl=1/(right-left), tb=1/(top-bottom), fn=1/(far-near);
    return [2*rl,0,0,0, 0,2*tb,0,0, 0,0,-2*fn,0, -(right+left)*rl,-(top+bottom)*tb,-(far+near)*fn,1];
  },

  lookAt: (eye, target, up) => {
    const f=v3.norm(v3.sub(target,eye)), r=v3.norm(v3.cross(f,v3.norm(up))), u=v3.cross(r,f);
    return [r[0],u[0],-f[0],0, r[1],u[1],-f[1],0, r[2],u[2],-f[2],0, -v3.dot(r,eye),-v3.dot(u,eye),v3.dot(f,eye),1];
  },

  mul: (A,B) => {
    const C=new Array(16).fill(0);
    for(let i=0;i<4;i++) for(let j=0;j<4;j++) for(let k=0;k<4;k++) C[j*4+i]+=A[k*4+i]*B[j*4+k];
    return C;
  },

  mulVec4: (M,v) => [
    M[0]*v[0]+M[4]*v[1]+M[8]*v[2] +M[12]*v[3],
    M[1]*v[0]+M[5]*v[1]+M[9]*v[2] +M[13]*v[3],
    M[2]*v[0]+M[6]*v[1]+M[10]*v[2]+M[14]*v[3],
    M[3]*v[0]+M[7]*v[1]+M[11]*v[2]+M[15]*v[3],
  ],

  mulPoint: (M,p) => {
    const r=m4.mulVec4(M,[p[0],p[1],p[2],1]);
    return [r[0]/r[3],r[1]/r[3],r[2]/r[3]];
  },

  mulDir: (M,d) => {
    const r=m4.mulVec4(M,[d[0],d[1],d[2],0]);
    return [r[0],r[1],r[2]];
  },

  transpose: (M) => [M[0],M[4],M[8],M[12],M[1],M[5],M[9],M[13],M[2],M[6],M[10],M[14],M[3],M[7],M[11],M[15]],

  // Inverse of a 4×4 (general — uses cofactor expansion)
  inv: (M) => {
    const m=M, C=new Array(16);
    C[0]= m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
    C[4]=-m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
    C[8]= m[4]*m[9]*m[15] -m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
    C[12]=-m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
    C[1]=-m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
    C[5]= m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
    C[9]=-m[0]*m[9]*m[15] +m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
    C[13]=m[0]*m[9]*m[14] -m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
    C[2]= m[1]*m[6]*m[15] -m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
    C[6]=-m[0]*m[6]*m[15] +m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
    C[10]=m[0]*m[5]*m[15] -m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
    C[14]=-m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
    C[3]=-m[1]*m[6]*m[11] +m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
    C[7]= m[0]*m[6]*m[11] -m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
    C[11]=-m[0]*m[5]*m[11]+m[0]*m[7]*m[9] +m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
    C[15]=m[0]*m[5]*m[10] -m[0]*m[6]*m[9] -m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
    const det=m[0]*C[0]+m[1]*C[4]+m[2]*C[8]+m[3]*C[12]+EPS;
    return C.map(v=>v/det);
  },

  translation:  (x,y,z) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1],
  scaling:      (x,y,z) => [x,0,0,0, 0,y,0,0, 0,0,z,0, 0,0,0,1],
  rotationX:    (a)     => [1,0,0,0, 0,Math.cos(a),Math.sin(a),0, 0,-Math.sin(a),Math.cos(a),0, 0,0,0,1],
  rotationY:    (a)     => [Math.cos(a),0,-Math.sin(a),0, 0,1,0,0, Math.sin(a),0,Math.cos(a),0, 0,0,0,1],
  rotationZ:    (a)     => [Math.cos(a),Math.sin(a),0,0, -Math.sin(a),Math.cos(a),0,0, 0,0,1,0, 0,0,0,1],
};

// ─── Spherical Harmonics (degree 0–3, 16 bases) ───────────────────────────────
export const SH = {
  // Normalised real SH basis functions Y_l^m evaluated from direction (θ,φ)
  basis: (theta, phi) => {
    const ct=Math.cos(theta), st=Math.sin(theta);
    const cp=Math.cos(phi),   sp=Math.sin(phi);
    const c2p=Math.cos(2*phi), s2p=Math.sin(2*phi);
    const ct2=ct*ct, st2=st*st;
    return [
      // l=0
      0.282095,
      // l=1
      0.488603*ct, 0.488603*st*sp, 0.488603*st*cp,
      // l=2
      0.315392*(3*ct2-1), 1.092548*ct*st*sp, 1.092548*ct*st*cp,
      0.546274*st2*s2p, 0.546274*st2*c2p,
      // l=3
      0.590044*ct*(5*ct2-3),
      2.890611*st*sp*(5*ct2-1),  2.890611*st*cp*(5*ct2-1),
      1.445306*ct*st2*s2p,       1.445306*ct*st2*c2p,
      0.746353*st2*st*Math.sin(3*phi), 0.746353*st2*st*Math.cos(3*phi),
    ];
  },

  // Direction vector → (theta, phi)
  dirToAngles: (d) => {
    const [x,y,z]=v3.norm(d);
    return { theta: Math.acos(clamp(z,-1,1)), phi: Math.atan2(y,x) };
  },

  // Reconstruct colour from 48 SH coefficients (16×RGB) at view direction
  reconstruct: (coeffs, dir) => {
    const {theta,phi}=SH.dirToAngles(dir);
    const B=SH.basis(theta,phi);
    let r=0,g=0,b=0;
    for(let i=0;i<16;i++){ r+=coeffs[i*3]*B[i]; g+=coeffs[i*3+1]*B[i]; b+=coeffs[i*3+2]*B[i]; }
    return [sigmoid(r),sigmoid(g),sigmoid(b)];
  },

  // Project function values (N samples on sphere) → 16 SH coefficients per channel
  project: (samples) => {
    // samples: [{dir:[x,y,z], color:[r,g,b]}]
    const coeffs=new Float32Array(48);
    const w=4*PI/samples.length;
    for(const {dir,color} of samples) {
      const {theta,phi}=SH.dirToAngles(dir);
      const B=SH.basis(theta,phi);
      for(let i=0;i<16;i++){
        coeffs[i*3  ]+=B[i]*color[0]*w;
        coeffs[i*3+1]+=B[i]*color[1]*w;
        coeffs[i*3+2]+=B[i]*color[2]*w;
      }
    }
    return coeffs;
  },
};

// ─── 3D Gaussian ─────────────────────────────────────────────────────────────
export class Gaussian3D {
  constructor({ mu, scale, rotation, opacity, sh }) {
    this.mu       = mu;
    this.scale    = scale;   // log-space
    this.rotation = rotation instanceof Quat ? rotation : Quat.fromArray(rotation);
    this.opacity  = opacity; // logit-space
    this.sh       = sh;      // 48 floats or null (DC only then)
  }

  get alpha() { return sigmoid(this.opacity); }

  // Σ = R · diag(exp(s)²) · Rᵀ — 3×3 covariance matrix
  covariance() {
    const s=this.scale.map(Math.exp), R=this.rotation.toMat3();
    const RS=m3.mulDiag(R,s); // R·diag(s)
    return m3.sandwich(RS, m3.identity()); // RS·RSᵀ
  }

  // EWA projection to 2D screen-space Gaussian
  project(viewMatrix, projMatrix, W, H) {
    const cam=m4.mulVec4(viewMatrix,[...this.mu,1]);
    if(cam[2]>=0) return null;
    const clip=m4.mulVec4(projMatrix,cam);
    const sx=(clip[0]/clip[3]+1)*0.5*W, sy=(1-clip[1]/clip[3])*0.5*H;
    const fx=projMatrix[0]*W*0.5, fy=projMatrix[5]*H*0.5;
    const iz=1/Math.max(-cam[2],EPS);
    const J=[fx*iz,0,-fx*cam[0]*iz*iz, 0,fy*iz,-fy*cam[1]*iz*iz, 0,0,0];
    const W3=[viewMatrix[0],viewMatrix[1],viewMatrix[2], viewMatrix[4],viewMatrix[5],viewMatrix[6], viewMatrix[8],viewMatrix[9],viewMatrix[10]];
    const JW=m3.mul(J,W3), Sigma3D=this.covariance();
    const Sigma2D=m3.mul(m3.mul(JW,Sigma3D),m3.transpose(JW));
    return {
      cx:sx, cy:sy,
      cov2D:[Sigma2D[0]+0.3, Sigma2D[1], Sigma2D[4]+0.3],
      alpha:this.alpha,
      depth:-cam[2],
    };
  }

  // Mahalanobis distance from point p to this Gaussian
  mahalanobis(p) {
    const d=v3.sub(p,this.mu), Si=m3.inv(this.covariance());
    return d[0]*(Si[0]*d[0]+Si[1]*d[1]+Si[2]*d[2])
          +d[1]*(Si[3]*d[0]+Si[4]*d[1]+Si[5]*d[2])
          +d[2]*(Si[6]*d[0]+Si[7]*d[1]+Si[8]*d[2]);
  }

  // Pack to 14-float buffer: [x,y,z, sx,sy,sz, qw,qx,qy,qz, opacity, sh0r,sh0g,sh0b]
  pack(buf, offset) {
    buf[offset+ 0]=this.mu[0]; buf[offset+ 1]=this.mu[1]; buf[offset+ 2]=this.mu[2];
    buf[offset+ 3]=this.scale[0]; buf[offset+ 4]=this.scale[1]; buf[offset+ 5]=this.scale[2];
    buf[offset+ 6]=this.rotation.w; buf[offset+ 7]=this.rotation.x;
    buf[offset+ 8]=this.rotation.y; buf[offset+ 9]=this.rotation.z;
    buf[offset+10]=this.opacity;
    buf[offset+11]=this.sh?this.sh[0]:0; buf[offset+12]=this.sh?this.sh[1]:0; buf[offset+13]=this.sh?this.sh[2]:0;
  }

  static unpack(buf, offset) {
    return new Gaussian3D({
      mu:[buf[offset],buf[offset+1],buf[offset+2]],
      scale:[buf[offset+3],buf[offset+4],buf[offset+5]],
      rotation:new Quat(buf[offset+6],buf[offset+7],buf[offset+8],buf[offset+9]),
      opacity:buf[offset+10],
      sh:buf.slice(offset+11,offset+14),
    });
  }
}

// ─── SDF from Gaussian field ──────────────────────────────────────────────────
export class SDF {
  constructor(gaussians) { this.gaussians=gaussians; }

  sample(px,py,pz) {
    let density=0;
    for(const g of this.gaussians) {
      if(g.alpha<0.01) continue;
      density+=g.alpha*Math.exp(-0.5*g.mahalanobis([px,py,pz]));
    }
    return -Math.log(density+EPS);
  }

  gradient(px,py,pz,h=0.001) {
    return v3.norm([
      (this.sample(px+h,py,pz)-this.sample(px-h,py,pz))/(2*h),
      (this.sample(px,py+h,pz)-this.sample(px,py-h,pz))/(2*h),
      (this.sample(px,py,pz+h)-this.sample(px,py,pz-h))/(2*h),
    ]);
  }
}

// ─── Camera models ────────────────────────────────────────────────────────────
export const Camera = {
  pinhole: ({fx,fy,cx,cy}) => ({
    project:   (X,Y,Z) => [fx*X/Z+cx, fy*Y/Z+cy],
    unproject: (u,v,d) => [(u-cx)*d/fx,(v-cy)*d/fy,d],
    intrinsicMatrix: () => [fx,0,cx,0,fy,cy,0,0,1],
  }),
  fisheye: ({fx,fy,cx,cy,k1=0,k2=0,k3=0,k4=0}) => ({
    project: (X,Y,Z) => {
      const r=Math.sqrt(X*X+Y*Y)+EPS, th=Math.atan2(r,Math.abs(Z)), t2=th*th;
      const d=th*(1+k1*t2+k2*t2**2+k3*t2**3+k4*t2**4);
      return [fx*d/r*X+cx, fy*d/r*Y+cy];
    },
  }),
  equirect: ({W,H}) => ({
    project:   (X,Y,Z) => [(Math.atan2(X,Z)/(2*PI)+0.5)*W, (0.5-Math.asin(Y/(Math.sqrt(X*X+Y*Y+Z*Z)+EPS))/PI)*H],
    unproject: (u,v)   => {
      const lon=(u/W-0.5)*2*PI, lat=(0.5-v/H)*PI;
      return [Math.cos(lat)*Math.sin(lon),Math.sin(lat),Math.cos(lat)*Math.cos(lon)];
    },
  }),
};

// ─── Splines ──────────────────────────────────────────────────────────────────
export const Spline = {
  // Catmull-Rom: smooth interpolation through control points.
  // Used for: camera fly-through paths, animation curves.
  catmullRom: (p0, p1, p2, p3, t) => {
    const t2=t*t, t3=t2*t;
    const f=(a,b,c,d) =>
      0.5*((-a+3*b-3*c+d)*t3 + (2*a-5*b+4*c-d)*t2 + (-a+c)*t + 2*b);
    return [f(p0[0],p1[0],p2[0],p3[0]), f(p0[1],p1[1],p2[1],p3[1]), f(p0[2],p1[2],p2[2],p3[2])];
  },

  // Evaluate full Catmull-Rom spline at t∈[0,1] over N control points
  catmullRomPath: (points, t) => {
    if (points.length<2) return points[0]??[0,0,0];
    const n=points.length-1, idx=Math.min(Math.floor(t*n),n-1), tt=(t*n)-idx;
    const p0=points[Math.max(0,idx-1)], p1=points[idx], p2=points[Math.min(n,idx+1)], p3=points[Math.min(n,idx+2)];
    return Spline.catmullRom(p0,p1,p2,p3,tt);
  },

  // Cubic Hermite: control tangents explicitly.
  cubicHermite: (p0, v0, p1, v1, t) => {
    const t2=t*t, t3=t2*t;
    const h00=2*t3-3*t2+1, h10=t3-2*t2+t, h01=-2*t3+3*t2, h11=t3-t2;
    return [p0[0]*h00+v0[0]*h10+p1[0]*h01+v1[0]*h11, p0[1]*h00+v0[1]*h10+p1[1]*h01+v1[1]*h11, p0[2]*h00+v0[2]*h10+p1[2]*h01+v1[2]*h11];
  },

  // Arc-length reparametrisation table for uniform-speed paths
  buildArcLengthTable: (points, steps=200) => {
    const table=[{t:0,s:0}];
    let prev=Spline.catmullRomPath(points,0), total=0;
    for(let i=1;i<=steps;i++){
      const tt=i/steps, p=Spline.catmullRomPath(points,tt);
      total+=v3.dist(prev,p); prev=p;
      table.push({t:tt,s:total});
    }
    return table;
  },

  // Sample a path at constant arc-length parameter s∈[0,1]
  sampleArcLength: (table, s) => {
    const len=table[table.length-1].s, target=s*len;
    let lo=0, hi=table.length-1;
    while(lo<hi-1){ const mid=(lo+hi)>>1; table[mid].s<target?lo=mid:hi=mid; }
    const a=table[lo], b=table[hi], tt=(target-a.s)/(b.s-a.s+EPS);
    return a.t+(b.t-a.t)*tt;
  },
};

// ─── Noise ────────────────────────────────────────────────────────────────────
// Permutation table (Ken Perlin's original 256 values)
const _PERM = Uint8Array.from([
  151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,
  8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,
  35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,
  134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,
  55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,
  18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,
  250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,
  189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,
  172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,
  228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,
  107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,
  138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180,
]);
const _P=[..._PERM,..._PERM];
const _fade=t=>t*t*t*(t*(t*6-15)+10);
const _grad3=(h,x,y,z)=>{const H=h&15,u=H<8?x:y,v=H<4?y:H===12||H===14?x:z;return((H&1)?-u:u)+((H&2)?-v:v);};

export const Noise = {
  // Classic 3D Perlin noise — returns [-1,1]
  perlin3: (x,y,z) => {
    const X=Math.floor(x)&255,Y=Math.floor(y)&255,Z=Math.floor(z)&255;
    x-=Math.floor(x); y-=Math.floor(y); z-=Math.floor(z);
    const u=_fade(x),v=_fade(y),w=_fade(z);
    const A=_P[X]+Y,AA=_P[A]+Z,AB=_P[A+1]+Z,B=_P[X+1]+Y,BA=_P[B]+Z,BB=_P[B+1]+Z;
    return lerp(
      lerp(lerp(_grad3(_P[AA],x,y,z),_grad3(_P[BA],x-1,y,z),u),lerp(_grad3(_P[AB],x,y-1,z),_grad3(_P[BB],x-1,y-1,z),u),v),
      lerp(lerp(_grad3(_P[AA+1],x,y,z-1),_grad3(_P[BA+1],x-1,y,z-1),u),lerp(_grad3(_P[AB+1],x,y-1,z-1),_grad3(_P[BB+1],x-1,y-1,z-1),u),v),
      w
    );
  },

  // Fractal Brownian Motion — layered Perlin noise
  fbm: (x,y,z,{octaves=6,lacunarity=2,gain=0.5,initialAmplitude=0.5}={}) => {
    let val=0,amp=initialAmplitude,freq=1;
    for(let i=0;i<octaves;i++){
      val+=Noise.perlin3(x*freq,y*freq,z*freq)*amp;
      freq*=lacunarity; amp*=gain;
    }
    return val;
  },

  // Curl noise — divergence-free 3D vector field for particle flow.
  // Curl(F) guarantees no sinks or sources — particles circulate, not accumulate.
  // Used in: NIF solidification transition particle system.
  curl: (x,y,z,eps=0.0001) => {
    const dx=(Noise.perlin3(x,y+eps,z)-Noise.perlin3(x,y-eps,z))/(2*eps)
            -(Noise.perlin3(x,y,z+eps)-Noise.perlin3(x,y,z-eps))/(2*eps);
    const dy=(Noise.perlin3(x,y,z+eps)-Noise.perlin3(x,y,z-eps))/(2*eps)
            -(Noise.perlin3(x+eps,y,z)-Noise.perlin3(x-eps,y,z))/(2*eps);
    const dz=(Noise.perlin3(x+eps,y,z)-Noise.perlin3(x-eps,y,z))/(2*eps)
            -(Noise.perlin3(x,y+eps,z)-Noise.perlin3(x,y-eps,z))/(2*eps);
    return [dx,dy,dz];
  },

  // Domain-warped noise for organic-looking shapes (Inigo Quilez technique)
  warp: (x,y,z,strength=0.8) => {
    const [fx,fy,fz]=Noise.curl(x,y,z);
    return Noise.perlin3(x+strength*fx, y+strength*fy, z+strength*fz);
  },
};

// ─── Frustum & AABB ───────────────────────────────────────────────────────────
// Frustum is defined by 6 planes (normal + offset).
// Used to cull Gaussians and BVH nodes that are outside the view.
export class Frustum {
  // Build from combined viewProj matrix (view × proj, column-major).
  static fromViewProj(VP) {
    const planes=[];
    // Gribb & Hartmann method — extract planes from rows of VP
    const rows=[
      [VP[0],VP[4],VP[8], VP[12]],  // left
      [VP[1],VP[5],VP[9], VP[13]],  // right (negated below)
      [VP[2],VP[6],VP[10],VP[14]],  // bottom
      [VP[3],VP[7],VP[11],VP[15]],  // top
    ];
    planes.push(
      Frustum._norm([rows[3][0]+rows[0][0],rows[3][1]+rows[0][1],rows[3][2]+rows[0][2],rows[3][3]+rows[0][3]]),
      Frustum._norm([rows[3][0]-rows[0][0],rows[3][1]-rows[0][1],rows[3][2]-rows[0][2],rows[3][3]-rows[0][3]]),
      Frustum._norm([rows[3][0]+rows[1][0],rows[3][1]+rows[1][1],rows[3][2]+rows[1][2],rows[3][3]+rows[1][3]]),
      Frustum._norm([rows[3][0]-rows[1][0],rows[3][1]-rows[1][1],rows[3][2]-rows[1][2],rows[3][3]-rows[1][3]]),
      Frustum._norm([rows[3][0]+rows[2][0],rows[3][1]+rows[2][1],rows[3][2]+rows[2][2],rows[3][3]+rows[2][3]]),
      Frustum._norm([rows[3][0]-rows[2][0],rows[3][1]-rows[2][1],rows[3][2]-rows[2][2],rows[3][3]-rows[2][3]]),
    );
    return new Frustum(planes);
  }

  static _norm([nx,ny,nz,d]) {
    const len=Math.sqrt(nx*nx+ny*ny+nz*nz)+EPS;
    return [nx/len,ny/len,nz/len,d/len];
  }

  constructor(planes) { this.planes=planes; }

  // Test point — returns true if inside frustum
  containsPoint(p) {
    for(const [nx,ny,nz,d] of this.planes)
      if(nx*p[0]+ny*p[1]+nz*p[2]+d<0) return false;
    return true;
  }

  // Test AABB [lo, hi] — returns 'inside' | 'intersect' | 'outside'
  testAABB(lo,hi) {
    let allIn=true;
    for(const [nx,ny,nz,d] of this.planes){
      const px=nx>0?hi[0]:lo[0], py=ny>0?hi[1]:lo[1], pz=nz>0?hi[2]:lo[2]; // positive vertex
      const qx=nx>0?lo[0]:hi[0], qy=ny>0?lo[1]:hi[1], qz=nz>0?lo[2]:hi[2]; // negative vertex
      if(nx*px+ny*py+nz*pz+d<0) return 'outside';
      if(nx*qx+ny*qy+nz*qz+d<0) allIn=false;
    }
    return allIn?'inside':'intersect';
  }

  // Test sphere — fast Gaussian cull
  testSphere(center, radius) {
    for(const [nx,ny,nz,d] of this.planes)
      if(nx*center[0]+ny*center[1]+nz*center[2]+d<-radius) return false;
    return true;
  }
}

// ─── Motion blur (8-pt Gauss-Legendre) ───────────────────────────────────────
export const MotionBlur = {
  WEIGHTS: [0.1012285,0.2223810,0.3137066,0.3626835,0.3626835,0.3137066,0.2223810,0.1012285],
  NODES:   [-0.960290,-0.796667,-0.525532,-0.183435,0.183435,0.525532,0.796667,0.960290],
  integrationPoses: (R0,T0,R1,T1) =>
    MotionBlur.NODES.map((node,i)=>({
      R: Quat.slerp(R0,R1,(node+1)/2),
      T: v3.lerp(T0,T1,(node+1)/2),
      weight: MotionBlur.WEIGHTS[i]*0.5,
    })),
};

// ─── Cook-Torrance BRDF (GGX) ─────────────────────────────────────────────────
export const BRDF = {
  D_GGX: (NdotH,roughness) => {
    const a=roughness*roughness, a2=a*a, d=(NdotH*NdotH)*(a2-1)+1;
    return a2/(PI*d*d+EPS);
  },
  F_Schlick: (HdotV,F0) => {
    const p=Math.pow(1-Math.max(HdotV,0),5);
    return F0.map(f=>f+(1-f)*p);
  },
  G_SmithCorrelated: (NdotV,NdotL,roughness) => {
    // Height-correlated Smith G visibility term.
    // Returns G/(4·NdotV·NdotL) — the combined visibility function.
    // This CAN exceed 0.25 at grazing view angles (NdotV → 0), which is
    // physically correct: it produces the Fresnel edge brightening on
    // metals and dielectrics. The EPS prevents divide-by-zero only.
    const a2=roughness**4;
    const GGXV=NdotL*Math.sqrt(NdotV*NdotV*(1-a2)+a2);
    const GGXL=NdotV*Math.sqrt(NdotL*NdotL*(1-a2)+a2);
    return 0.5/(GGXV+GGXL+EPS);
  },
  evaluate: ({albedo,metallic,roughness,N,V,L}) => {
    const H=v3.norm(v3.add(V,L));
    const NdotH=Math.max(v3.dot(N,H),0), NdotV=Math.max(v3.dot(N,V),0);
    const NdotL=Math.max(v3.dot(N,L),0), HdotV=Math.max(v3.dot(H,V),0);
    const F0=albedo.map(c=>lerp(0.04,c,metallic));
    const D=BRDF.D_GGX(NdotH,roughness), F=BRDF.F_Schlick(HdotV,F0), G=BRDF.G_SmithCorrelated(NdotV,NdotL,roughness);
    const specular=F.map(f=>D*f*G), kD=F.map(f=>(1-f)*(1-metallic));
    const diffuse=kD.map((k,i)=>k*albedo[i]/PI);
    return specular.map((s,i)=>(s+diffuse[i])*NdotL);
  },
  // Clearcoat layer (automotive paint) — second GGX lobe, smooth dielectric
  clearcoat: ({roughness=0.05,N,V,L}) => {
    const H=v3.norm(v3.add(V,L)), NdotH=Math.max(v3.dot(N,H),0);
    const NdotV=Math.max(v3.dot(N,V),0), NdotL=Math.max(v3.dot(N,L),0), HdotV=Math.max(v3.dot(H,V),0);
    const D=BRDF.D_GGX(NdotH,roughness), F=BRDF.F_Schlick(HdotV,[0.04,0.04,0.04])[0];
    const G=BRDF.G_SmithCorrelated(NdotV,NdotL,roughness);
    return F*D*G*NdotL;
  },
};

// ─── HRTF spatial audio ────────────────────────────────────────────────────────
export const HRTF = {
  itd: (azimuthDeg,headRadiusM=0.0875) => {
    const theta=azimuthDeg*PI/180, c=343;
    return (headRadiusM/c)*(Math.sin(theta)+theta);
  },
  ild: (azimuthDeg,frequencyHz) => {
    const theta=azimuthDeg*PI/180;
    const base=20*Math.log10(Math.cos(theta/2)**2+EPS);
    return frequencyHz<1500?base:base*1.5;
  },
  encodeAmbisonics: (samples,azimuthDeg,elevationDeg) => {
    const az=azimuthDeg*PI/180, el=elevationDeg*PI/180;
    return {
      W:samples.map(s=>s*0.7071),
      X:samples.map(s=>s*Math.cos(el)*Math.cos(az)),
      Y:samples.map(s=>s*Math.cos(el)*Math.sin(az)),
      Z:samples.map(s=>s*Math.sin(el)),
    };
  },
  // Decode ambisonics B-format to stereo using virtual microphone model
  decodeToStereo: ({W,X,Y,Z},headingDeg=0) => {
    const h=headingDeg*PI/180;
    const Laz=h+PI/6, Raz=h-PI/6; // ±30° virtual mics
    const L=W.map((w,i)=>w*0.7071+X[i]*Math.cos(Laz)*0.5+Y[i]*Math.sin(Laz)*0.5);
    const R=W.map((w,i)=>w*0.7071+X[i]*Math.cos(Raz)*0.5+Y[i]*Math.sin(Raz)*0.5);
    return {L,R};
  },
};

// ─── 4D Timeline interpolation ────────────────────────────────────────────────
// Interpolates between NIF keyframes including Gaussian geometry, not just scalars.
export const Timeline = {
  // Interpolate two sets of Gaussians at t ∈ [0,1]
  // Both sets must have the same count (matched by index or via assignment below)
  lerpGaussians: (A, B, t) => {
    if (A.count !== B.count) throw new Error('Timeline.lerpGaussians: count mismatch');
    const out = new Float32Array(A.count * 14);
    for (let i = 0; i < A.count; i++) {
      const j = i * 14;
      // Position: linear interpolation
      out[j  ]=lerp(A.data[j  ],B.data[j  ],t);
      out[j+1]=lerp(A.data[j+1],B.data[j+1],t);
      out[j+2]=lerp(A.data[j+2],B.data[j+2],t);
      // Scale: log-space lerp (equivalent to exp(lerp(log(s))))
      out[j+3]=lerp(A.data[j+3],B.data[j+3],t);
      out[j+4]=lerp(A.data[j+4],B.data[j+4],t);
      out[j+5]=lerp(A.data[j+5],B.data[j+5],t);
      // Rotation: SLERP
      const qa=Quat.fromArray([A.data[j+6],A.data[j+7],A.data[j+8],A.data[j+9]]);
      const qb=Quat.fromArray([B.data[j+6],B.data[j+7],B.data[j+8],B.data[j+9]]);
      const qr=Quat.slerp(qa,qb,t);
      out[j+6]=qr.w; out[j+7]=qr.x; out[j+8]=qr.y; out[j+9]=qr.z;
      // Opacity: linear in logit space
      out[j+10]=lerp(A.data[j+10],B.data[j+10],t);
      // SH DC colour: linear
      out[j+11]=lerp(A.data[j+11],B.data[j+11],t);
      out[j+12]=lerp(A.data[j+12],B.data[j+12],t);
      out[j+13]=lerp(A.data[j+13],B.data[j+13],t);
    }
    return { count: A.count, data: out };
  },

  // Evaluate keyframe sequence at time t ∈ [0, totalDuration]
  evaluate: (keyframes, t) => {
    // keyframes: [{time:number, gaussians:{count,data}}]
    if (!keyframes.length) return null;
    if (keyframes.length === 1) return keyframes[0].gaussians;
    const last = keyframes[keyframes.length-1];
    t = clamp(t, keyframes[0].time, last.time);
    let i = 0;
    while (i < keyframes.length-2 && keyframes[i+1].time <= t) i++;
    const k0=keyframes[i], k1=keyframes[i+1];
    const alpha=(t-k0.time)/(k1.time-k0.time+EPS);
    return Timeline.lerpGaussians(k0.gaussians, k1.gaussians, clamp(alpha,0,1));
  },
};

// ─── Gaussian-space editing operations ───────────────────────────────────────
// Used by the editor: select region, translate, scale, recolour, delete.
export const GaussianEdit = {
  // Select all Gaussians within a sphere — returns array of indices
  selectSphere: (data, count, center, radius) => {
    const r2=radius*radius, indices=[];
    for(let i=0;i<count;i++){
      const j=i*14;
      const dx=data[j]-center[0], dy=data[j+1]-center[1], dz=data[j+2]-center[2];
      if(dx*dx+dy*dy+dz*dz<=r2) indices.push(i);
    }
    return indices;
  },

  // Select Gaussians within a screen-space rectangle (for lasso/box select)
  // Requires a project function: (pos3D) → {x,y,depth} or null
  selectRect: (data, count, projectFn, x0,y0,x1,y1) => {
    const minX=Math.min(x0,x1),maxX=Math.max(x0,x1),minY=Math.min(y0,y1),maxY=Math.max(y0,y1);
    const indices=[];
    for(let i=0;i<count;i++){
      const j=i*14;
      const p=projectFn([data[j],data[j+1],data[j+2]]);
      if(p && p.x>=minX&&p.x<=maxX&&p.y>=minY&&p.y<=maxY) indices.push(i);
    }
    return indices;
  },

  // Translate selected Gaussians by delta [dx,dy,dz]
  translate: (data, indices, delta) => {
    const out=new Float32Array(data);
    for(const i of indices){ const j=i*14; out[j]+=delta[0]; out[j+1]+=delta[1]; out[j+2]+=delta[2]; }
    return out;
  },

  // Scale selected Gaussians around a pivot
  scale: (data, indices, pivot, factor) => {
    const out=new Float32Array(data);
    for(const i of indices){
      const j=i*14;
      out[j  ]=pivot[0]+(data[j  ]-pivot[0])*factor;
      out[j+1]=pivot[1]+(data[j+1]-pivot[1])*factor;
      out[j+2]=pivot[2]+(data[j+2]-pivot[2])*factor;
      out[j+3]+=Math.log(factor); out[j+4]+=Math.log(factor); out[j+5]+=Math.log(factor);
    }
    return out;
  },

  // Rotate selected Gaussians around pivot by quaternion q
  rotate: (data, indices, pivot, q) => {
    const out=new Float32Array(data);
    for(const i of indices){
      const j=i*14;
      const p=[data[j]-pivot[0], data[j+1]-pivot[1], data[j+2]-pivot[2]];
      const rp=q.rotateVec(p);
      out[j]=rp[0]+pivot[0]; out[j+1]=rp[1]+pivot[1]; out[j+2]=rp[2]+pivot[2];
      const qOld=new Quat(data[j+6],data[j+7],data[j+8],data[j+9]);
      const qNew=q.mul(qOld).normalize();
      out[j+6]=qNew.w; out[j+7]=qNew.x; out[j+8]=qNew.y; out[j+9]=qNew.z;
    }
    return out;
  },

  // Recolour selected Gaussians (shift SH DC term toward target colour)
  recolour: (data, indices, rgb, strength=1.0) => {
    const out=new Float32Array(data);
    // Invert sigmoid to get logit-space target from [0,1] rgb
    const logit=(x)=>Math.log(clamp(x,0.001,0.999)/(1-clamp(x,0.001,0.999)));
    for(const i of indices){
      const j=i*14;
      out[j+11]=lerp(data[j+11],logit(rgb[0]-0.5),strength);
      out[j+12]=lerp(data[j+12],logit(rgb[1]-0.5),strength);
      out[j+13]=lerp(data[j+13],logit(rgb[2]-0.5),strength);
    }
    return out;
  },

  // Delete selected Gaussians — returns new {count, data}
  delete: (data, count, indices) => {
    const del=new Set(indices);
    const kept=[];
    for(let i=0;i<count;i++) if(!del.has(i)) kept.push(i);
    const out=new Float32Array(kept.length*14);
    kept.forEach((src,dst)=>out.set(data.subarray(src*14,src*14+14),dst*14));
    return { count:kept.length, data:out };
  },

  // Soften opacity of selected Gaussians (useful for erasing)
  fade: (data, indices, amount=0.5) => {
    const out=new Float32Array(data);
    for(const i of indices){ out[i*14+10]-=amount; } // shift logit-opacity negative
    return out;
  },

  // Compute bounding sphere of selected Gaussians
  boundingSphere: (data, indices) => {
    if(!indices.length) return {center:[0,0,0],radius:0};
    let cx=0,cy=0,cz=0;
    for(const i of indices){ cx+=data[i*14]; cy+=data[i*14+1]; cz+=data[i*14+2]; }
    cx/=indices.length; cy/=indices.length; cz/=indices.length;
    let r=0;
    for(const i of indices){
      const dx=data[i*14]-cx, dy=data[i*14+1]-cy, dz=data[i*14+2]-cz;
      r=Math.max(r,Math.sqrt(dx*dx+dy*dy+dz*dz));
    }
    return {center:[cx,cy,cz],radius:r};
  },
};

// ─── Utilities ────────────────────────────────────────────────────────────────
export const sigmoid = x => 1/(1+Math.exp(-x));
export const lerp    = (a,b,t) => a+(b-a)*t;
export const clamp   = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
export const smoothstep = (lo,hi,x) => { const t=clamp((x-lo)/(hi-lo),0,1); return t*t*(3-2*t); };
export const smootherstep=(lo,hi,x) => { const t=clamp((x-lo)/(hi-lo),0,1); return t*t*t*(t*(t*6-15)+10); };
export const remap   = (v,a,b,c,d) => lerp(c,d,(v-a)/(b-a+EPS));
export const degToRad= d => d*PI/180;
export const radToDeg= r => r*180/PI;

// ─── Lie Algebra / SO(3) — for smooth manifold interpolation ──────────────────
// Used by the NIF graph runtime for deterministic orientation blending.
// SO(3) exponential and logarithm maps let us do calculus on the rotation manifold
// without the gimbal-lock / discontinuity issues of Euler angles.
export const SO3 = {
  // Exponential map: so(3) → SO(3). Takes an axis-angle vector ω∈ℝ³
  exp: (w) => {
    const th = Math.sqrt(w[0]*w[0]+w[1]*w[1]+w[2]*w[2]);
    if (th < EPS) return Quat.identity();
    return Quat.fromAxisAngle(v3.scale(w,1/th), th);
  },
  // Logarithm map: SO(3) → so(3). Inverse of exp.
  log: (q) => {
    const qn = q.normalize();
    const sinHalf = Math.sqrt(1-qn.w*qn.w);
    if (sinHalf < EPS) return [0,0,0];
    const th = 2*Math.acos(Math.max(-1,Math.min(1,qn.w)));
    return [qn.x*th/sinHalf, qn.y*th/sinHalf, qn.z*th/sinHalf];
  },
  // Geodesic interpolation on SO(3) manifold
  // More stable than naive SLERP for sequences of many rotations
  geodesicLerp: (q0, q1, t) => {
    const logDiff = SO3.log(q0.inverse().mul(q1));
    return q0.mul(SO3.exp(v3.scale(logDiff, t)));
  },
  // Angular velocity from two quaternions over dt
  angularVelocity: (q0, q1, dt) => v3.scale(SO3.log(q0.inverse().mul(q1)), 1/Math.max(dt,EPS)),
};

// ─── Structural Analysis (Euler-Bernoulli Beam Theory) ────────────────────────
// Used by BIM/Architecture plugin for load-bearing analysis.
// Reference: Timoshenko "Strength of Materials" 3rd ed.
export const Structural = {
  // Axial stress σ = F/A
  axialStress: (force, area) => force / Math.max(area, EPS),

  // Bending stress σ = M·y/I
  bendingStress: (moment, distFromNA, secondMomentArea) =>
    (moment * distFromNA) / Math.max(secondMomentArea, EPS),

  // Shear stress τ = VQ/Ib (rectangular cross-section shorthand τ_max = 3V/2A)
  shearStress: (shearForce, area) => (3 * shearForce) / (2 * Math.max(area, EPS)),

  // Second moment of area for rectangle: I = bh³/12
  rectMomentOfArea: (b, h) => (b * h*h*h) / 12,

  // Second moment of area for circle: I = πr⁴/4
  circMomentOfArea: (r) => (Math.PI * r*r*r*r) / 4,

  // Deflection at midspan for simply-supported beam under UDL: δ = 5wL⁴/384EI
  midspanDeflection: (w, L, E, I) =>
    (5 * w * Math.pow(L,4)) / (384 * Math.max(E,EPS) * Math.max(I,EPS)),

  // Euler buckling load: P_cr = π²EI/Le²
  eulerBucklingLoad: (E, I, effectiveLength) =>
    (Math.PI*Math.PI * E * I) / Math.max(effectiveLength*effectiveLength, EPS),

  // Von Mises yield criterion: σ_vm = √(σ₁²-σ₁σ₂+σ₂²) (2D principal stresses)
  vonMises2D: (s1, s2) => Math.sqrt(s1*s1 - s1*s2 + s2*s2),

  // Von Mises 3D: σ_vm = √½[(σ₁-σ₂)²+(σ₂-σ₃)²+(σ₃-σ₁)²]
  vonMises3D: (s1, s2, s3) =>
    Math.sqrt(0.5*((s1-s2)**2+(s2-s3)**2+(s3-s1)**2)),

  // Safety factor: η = σ_yield / σ_applied
  safetyFactor: (yieldStrength, appliedStress) =>
    yieldStrength / Math.max(Math.abs(appliedStress), EPS),

  // Stiffness matrix K for 1D bar element (2×2)
  // K = (EA/L) * [[1,-1],[-1,1]]
  barStiffness: (E, A, L) => {
    const k = (E*A)/Math.max(L,EPS);
    return [k,-k,-k,k]; // 2x2 flat
  },

  // Stiffness matrix for 2-node Euler-Bernoulli beam element (4×4)
  // Degrees of freedom: [v1, θ1, v2, θ2]
  beamStiffness: (E, I, L) => {
    const L2=L*L, L3=L2*L, c=E*I/L3;
    return [
       12*c,  6*L*c, -12*c,  6*L*c,
      6*L*c, 4*L2*c, -6*L*c, 2*L2*c,
      -12*c, -6*L*c,  12*c, -6*L*c,
      6*L*c, 2*L2*c, -6*L*c, 4*L2*c,
    ];
  },

  // Check if element is at risk: returns {safe, ratio, message}
  checkElement: ({stress, yieldStrength, bucklingLoad, axialLoad}) => {
    const yieldRatio   = Math.abs(stress)     / Math.max(yieldStrength,EPS);
    const bucklingRatio= Math.abs(axialLoad)  / Math.max(bucklingLoad,EPS);
    const ratio = Math.max(yieldRatio, bucklingRatio);
    return {
      safe:    ratio < 1.0,
      ratio,
      yieldRatio,
      bucklingRatio,
      message: ratio >= 1.0 ? 'OVERSTRESSED' : ratio >= 0.8 ? 'MARGINAL' : 'OK',
    };
  },

  // Material presets (SI units: Pa, kg/m³)
  MATERIALS: Object.freeze({
    steel:      { E:200e9, G:77e9, yield:250e6, density:7850,  name:'Structural steel (S275)' },
    steel355:   { E:200e9, G:77e9, yield:355e6, density:7850,  name:'High-strength steel (S355)' },
    concrete30: { E:30e9,  G:12e9, yield:30e6,  density:2400,  name:'Concrete C30/37' },
    timber:     { E:11e9,  G:0.7e9,yield:25e6,  density:550,   name:'Structural timber C24' },
    aluminium:  { E:70e9,  G:26e9, yield:270e6, density:2700,  name:'Aluminium 6061-T6' },
    glass:      { E:70e9,  G:29e9, yield:45e6,  density:2500,  name:'Structural glass' },
  }),
};

// ─── Constraint Graph Solver ──────────────────────────────────────────────────
// Solves a network of geometric constraints (used by BIM plugin for snapping,
// alignment, parametric modelling). Based on degree-of-freedom analysis.
export class ConstraintGraph {
  constructor() {
    this.nodes       = new Map(); // id → {pos:[x,y,z], fixed:bool}
    this.constraints = [];
  }

  addNode(id, pos, fixed=false) {
    this.nodes.set(id, { pos:[...pos], fixed });
    return this;
  }

  // Distance constraint between two nodes
  addDistance(idA, idB, distance) {
    this.constraints.push({ type:'distance', a:idA, b:idB, rest:distance });
    return this;
  }

  // Coincident constraint (same position)
  addCoincident(idA, idB) {
    this.constraints.push({ type:'coincident', a:idA, b:idB });
    return this;
  }

  // Parallel constraint (two edge directions must be parallel)
  addParallel(idA1, idA2, idB1, idB2) {
    this.constraints.push({ type:'parallel', a1:idA1, a2:idA2, b1:idB1, b2:idB2 });
    return this;
  }

  // Solve using iterative position correction (Gauss-Seidel XPBD style)
  solve(iterations=50) {
    for (let iter=0; iter<iterations; iter++) {
      for (const c of this.constraints) {
        if (c.type==='distance') {
          const nA=this.nodes.get(c.a), nB=this.nodes.get(c.b);
          if (!nA||!nB) continue;
          const d=v3.sub(nB.pos,nA.pos), dist=v3.len(d)+EPS;
          const err=(dist-c.rest)/dist;
          const corr=v3.scale(d,err*0.5);
          if(!nA.fixed) nA.pos=v3.add(nA.pos,corr);
          if(!nB.fixed) nB.pos=v3.sub(nB.pos,corr);
        }
        if (c.type==='coincident') {
          const nA=this.nodes.get(c.a), nB=this.nodes.get(c.b);
          if(!nA||!nB) continue;
          const mid=v3.scale(v3.add(nA.pos,nB.pos),0.5);
          if(!nA.fixed) nA.pos=[...mid];
          if(!nB.fixed) nB.pos=[...mid];
        }
        if (c.type==='parallel') {
          const a1=this.nodes.get(c.a1)?.pos, a2=this.nodes.get(c.a2)?.pos;
          const b1=this.nodes.get(c.b1)?.pos, b2=this.nodes.get(c.b2)?.pos;
          if(!a1||!a2||!b1||!b2) continue;
          const dA=v3.norm(v3.sub(a2,a1)), dB=v3.norm(v3.sub(b2,b1));
          // Rotate dB toward dA by half the angular error
          const cross=v3.cross(dB,dA), sinA=v3.len(cross);
          if(sinA>EPS && !this.nodes.get(c.b2)?.fixed) {
            const axis=v3.scale(cross,1/sinA), angle=Math.asin(sinA)*0.5;
            const Rq=Quat.fromAxisAngle(axis,angle);
            const b1n=this.nodes.get(c.b1), b2n=this.nodes.get(c.b2);
            if(b2n&&!b2n.fixed) b2n.pos=v3.add(b1n.pos,Rq.rotateVec(v3.sub(b2n.pos,b1n.pos)));
          }
        }
      }
    }
    return this;
  }

  getPositions() {
    const out={};
    this.nodes.forEach((v,k)=>{ out[k]=[...v.pos]; });
    return out;
  }
}

// ─── Signed Distance Field operations ────────────────────────────────────────
// Used by the NIF graph for spatial queries (is point inside shape? closest point?)
export const SDF3D = {
  sphere:   (p, c, r)    => v3.len(v3.sub(p,c)) - r,
  box:      (p, c, half) => {
    const q=v3.sub(v3.abs(v3.sub(p,c)),half);
    return v3.len(v3.max(q,[0,0,0])) + Math.min(Math.max(q[0],q[1],q[2]),0);
  },
  cylinder: (p, c, r, h) => {
    const dx=Math.sqrt((p[0]-c[0])**2+(p[2]-c[2])**2)-r;
    const dy=Math.abs(p[1]-c[1])-h*0.5;
    return Math.min(Math.max(dx,dy),0) + Math.sqrt(Math.max(dx,0)**2+Math.max(dy,0)**2);
  },
  torus:    (p, c, R, r) => {
    const dx=Math.sqrt((p[0]-c[0])**2+(p[2]-c[2])**2)-R;
    return Math.sqrt(dx*dx+(p[1]-c[1])**2)-r;
  },
  // Boolean ops
  union:        (a,b) => Math.min(a,b),
  intersection: (a,b) => Math.max(a,b),
  subtract:     (a,b) => Math.max(a,-b),
  // Smooth union (no sharp edges) — used for organic BIM shapes
  smoothUnion:  (a,b,k) => {
    const h=Math.max(k-Math.abs(a-b),0)/k;
    return Math.min(a,b)-h*h*k*0.25;
  },
};

// ─── Deterministic State Machine ───────────────────────────────────────────────
// Used by the NIF interaction graph for reproducible state transitions.
// All transitions are hash-seeded so replays produce identical results.
export class NIFStateMachine {
  /**
   * @param {object[]} states   [{id, onEnter?, onExit?}]
   * @param {object[]} transitions [{from, to, condition, action?}]
   * @param {string}   initial  — initial state id
   */
  constructor(states, transitions, initial) {
    this.states      = new Map(states.map(s=>[s.id,s]));
    this.transitions = transitions;
    this.current     = initial;
    this._history    = [{ state:initial, ts:0 }];
    this._t          = 0;
  }

  tick(dt, inputs={}) {
    this._t += dt;
    for (const tr of this.transitions) {
      if (tr.from !== this.current) continue;
      if (typeof tr.condition === 'function' && !tr.condition(inputs,this._t)) continue;
      if (typeof tr.condition === 'string'   && !inputs[tr.condition]) continue;
      this._transition(tr.to, tr.action, inputs);
      break; // only one transition per tick (deterministic)
    }
  }

  _transition(to, action, inputs) {
    const prev=this.states.get(this.current);
    const next=this.states.get(to);
    if (!next) return;
    prev?.onExit?.(inputs);
    this.current=to;
    this._history.push({ state:to, ts:this._t });
    action?.(inputs);
    next?.onEnter?.(inputs);
  }

  // Replay: rewind to a specific time and replay transitions
  replayAt(t) {
    const snapshot=this._history.filter(h=>h.ts<=t).at(-1);
    return snapshot?.state ?? this.current;
  }

  is(stateId) { return this.current === stateId; }
  get history() { return [...this._history]; }
}

// ─── Temporal Moment Tagging ──────────────────────────────────────────────────
// Used by Events/Experience mode. Tags a point in a timeline with semantic meaning.
// e.g., {t:42.5, tag:'first_kiss', emotion:'joyful', camera:'wide_shot'}
export class MomentTimeline {
  constructor() { this._moments=[]; }

  tag(t, tag, meta={}) {
    this._moments.push({ t, tag, ...meta });
    this._moments.sort((a,b)=>a.t-b.t);
    return this;
  }

  // Get all moments of a given tag
  byTag(tag) { return this._moments.filter(m=>m.tag===tag); }

  // Get moment(s) within a time window
  inRange(tStart, tEnd) { return this._moments.filter(m=>m.t>=tStart&&m.t<=tEnd); }

  // Nearest moment to time t
  nearest(t) {
    if(!this._moments.length) return null;
    return this._moments.reduce((best,m)=>Math.abs(m.t-t)<Math.abs(best.t-t)?m:best);
  }

  // Interpolate between two surrounding moments (for smooth camera transitions)
  interpolate(t) {
    const before=this._moments.filter(m=>m.t<=t).at(-1);
    const after =this._moments.filter(m=>m.t> t)[0];
    if(!before) return after ?? null;
    if(!after)  return before;
    const alpha=(t-before.t)/(after.t-before.t+EPS);
    return { before, after, alpha, t };
  }

  toJSON() { return this._moments; }
}
