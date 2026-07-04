/**
 * NIFGraph — Universal 4-Layer Graph Model
 * © Fumoca Technologies · fumoca.co.za
 *
 * Implements the NIF specification exactly as designed:
 *
 *   Layer 1: SPATIAL   — geometry nodes (meshes, depth fields, images, procedural)
 *   Layer 2: TEMPORAL  — time events, animations, tagged moments, replayable sequences
 *   Layer 3: SEMANTIC  — meaning and roles (door, beam, bride, load-bearing, first_dance)
 *   Layer 4: INTERACTION — user/system behaviour, triggers, scripts, state transitions
 *
 * External assets (glTF, USD, video, point clouds) are referenced, never embedded.
 * The graph itself is the portable layer. The runtime resolves it.
 *
 * Plugin system: industries register schemas that extend the semantic and
 * interaction layers without modifying the core.
 */

import {
  v3, m4, Quat, NIFStateMachine, MomentTimeline,
  clamp, EPS
} from '../math/NIFMath.js';

// ─── Node types ───────────────────────────────────────────────────────────────
export const NODE_TYPE = Object.freeze({
  // Spatial
  DEPTH_FIELD:  'depth_field',   // NIF's primary content type
  MESH:         'mesh',          // glTF / OBJ / STL reference
  POINT_CLOUD:  'point_cloud',   // LAS / LAZ / XYZ reference
  IMAGE:        'image',         // Still image / texture
  VIDEO:        'video',         // Video reference (mp4/webm)
  AUDIO:        'audio',         // Audio source
  PROCEDURAL:   'procedural',    // Generated geometry (boxes, spheres, parametric)
  LIGHT:        'light',         // Directional / point / spot / area
  CAMERA:       'camera',        // Viewpoint definition
  ANCHOR:       'anchor',        // Empty transform node (parent for groups)
  // Temporal
  MOMENT:       'moment',        // Tagged point in time
  SEQUENCE:     'sequence',      // Ordered list of moments
  ANIMATION:    'animation',     // Property animation curve
  // Semantic
  LABEL:        'label',         // Semantic role tag
  MEASUREMENT:  'measurement',   // BIM measurement annotation
  CONSTRAINT:   'constraint',    // BIM geometric/structural constraint
  // Interaction
  TRIGGER:      'trigger',       // Input event source
  ACTION:       'action',        // Output behaviour
  STATE:        'state',         // Discrete state node
  SCRIPT:       'script',        // Deterministic JS function
});

// ─── Edge types ────────────────────────────────────────────────────────────────
export const EDGE_TYPE = Object.freeze({
  CHILD:        'child',         // Spatial parent→child
  REFERENCES:   'references',   // External asset reference
  TAGGED_AS:    'tagged_as',    // Spatial→Semantic
  TRIGGERS:     'triggers',     // Interaction: event→action
  ANIMATES:     'animates',     // Temporal: animation→property
  CONSTRAINS:   'constrains',   // Semantic: constraint→nodes
  SUCCEEDS:     'succeeds',     // Temporal: moment order
  DEPENDS_ON:   'depends_on',   // State machine dependency
  GROUPS:       'groups',       // Logical grouping
});

// ─── Core graph node ──────────────────────────────────────────────────────────
export class NIFNode {
  constructor(id, type, opts={}) {
    this.id         = id;
    this.type       = type;
    this.label      = opts.label     ?? '';
    this.transform  = opts.transform ?? m4.identity();
    this.visible    = opts.visible   ?? true;
    this.meta       = opts.meta      ?? {};   // plugin-specific data
    this.created    = Date.now();
    this._edges     = [];  // {type, targetId, weight, meta}
  }

  addEdge(type, targetId, meta={}) {
    this._edges.push({ type, targetId, meta });
    return this;
  }

  getEdges(type=null) {
    return type ? this._edges.filter(e=>e.type===type) : this._edges;
  }

  toJSON() {
    return {
      id:this.id, type:this.type, label:this.label,
      transform:this.transform, visible:this.visible,
      meta:this.meta, edges:this._edges,
    };
  }
}

// ─── Spatial layer node ────────────────────────────────────────────────────────
export class SpatialNode extends NIFNode {
  /**
   * @param {string} id
   * @param {string} type — one of NODE_TYPE spatial values
   * @param {object} opts
   *   assetRef:    { type:'gltf'|'usd'|'nif'|'las'|'video'|'image'|'url', url:string }
   *   boundingBox: { min:[x,y,z], max:[x,y,z] }
   *   lod:         [{ distance, representation:'depth_field'|'mesh'|'image'|'proxy' }]
   */
  constructor(id, type, opts={}) {
    super(id, type, opts);
    this.assetRef   = opts.assetRef   ?? null;
    this.boundingBox= opts.boundingBox?? null;
    // LOD ladder — runtime picks representation by device capability + distance
    this.lod = opts.lod ?? [
      { distance:0,    representation:'depth_field' },
      { distance:50,   representation:'mesh'        },
      { distance:200,  representation:'image'       },
      { distance:1000, representation:'proxy'       },
    ];
  }

  // Pick best representation for given camera distance and device tier
  selectRepresentation(camDist, deviceTier=2) {
    // Lower-tier devices skip depth_field for far-off objects
    const reps = this.lod.filter(l => {
      if (deviceTier === 0 && l.representation === 'depth_field' && camDist > 10) return false;
      return camDist >= l.distance;
    });
    return reps.at(-1)?.representation ?? 'proxy';
  }
}

// ─── Temporal layer ────────────────────────────────────────────────────────────
export class TemporalGraph {
  constructor() {
    this.timeline  = new MomentTimeline();
    this.sequences = new Map();  // id → {name, moments:[], loop, pingpong}
    this.animations= new Map();  // id → {target, property, keyframes:[{t,v}], easing}
    this._t        = 0;
  }

  // Tag a moment (wedding: 'first_kiss', construction: 'concrete_pour', etc)
  tagMoment(t, tag, meta={}) {
    this.timeline.tag(t, tag, meta);
    return this;
  }

  // Define a named sequence (replayable section)
  defineSequence(id, name, momentTags, opts={}) {
    this.sequences.set(id, { name, momentTags, loop:opts.loop??false, pingpong:opts.pingpong??false });
    return this;
  }

  // Define an animation curve for a node property
  animate(id, targetNodeId, property, keyframes, easing='linear') {
    this.animations.set(id, { targetNodeId, property, keyframes, easing });
    return this;
  }

  // Evaluate all animations at time t — returns map of {nodeId→{property→value}}
  evaluate(t) {
    const out = new Map();
    this.animations.forEach((anim, animId) => {
      const kfs = anim.keyframes;
      if (!kfs.length) return;
      // Find surrounding keyframes
      let i = kfs.findIndex(k => k.t > t);
      if (i === -1) i = kfs.length;
      const k0 = kfs[Math.max(0, i-1)], k1 = kfs[Math.min(kfs.length-1, i)];
      const alpha = k0===k1 ? 1 : clamp((t-k0.t)/(k1.t-k0.t+EPS),0,1);

      let val;
      if (Array.isArray(k0.v)) {
        // Vector / quaternion
        if (k0.v.length === 4 && anim.property.includes('rotation')) {
          val = Quat.slerp(Quat.fromArray(k0.v), Quat.fromArray(k1.v), alpha).toArray();
        } else {
          val = k0.v.map((v,i) => v + (k1.v[i]-v)*alpha);
        }
      } else {
        val = k0.v + (k1.v - k0.v) * alpha;
      }

      const nodeMap = out.get(anim.targetNodeId) ?? {};
      nodeMap[anim.property] = val;
      out.set(anim.targetNodeId, nodeMap);
    });
    return out;
  }

  tick(dt) { this._t += dt; return this.evaluate(this._t); }
}

// ─── Semantic layer ────────────────────────────────────────────────────────────
// Industry plugins register their schemas here.
// The core never hardcodes 'door' or 'beam' — those come from plugins.
export class SemanticGraph {
  constructor() {
    this._labels    = new Map(); // nodeId → Set<tag>
    this._schemas   = new Map(); // pluginId → {tags, constraints, validate}
    this._measurements = [];
  }

  // Register an industry plugin schema
  registerPlugin(pluginId, schema) {
    /*
     * schema: {
     *   tags: ['door','beam','load-bearing','first_dance'],
     *   constraints: { 'load-bearing': { minSafetyFactor:2.0 } },
     *   validate: (node, labels) => { warnings:[], errors:[] }
     * }
     */
    this._schemas.set(pluginId, schema);
    return this;
  }

  // Tag a node with a semantic role
  tag(nodeId, ...tags) {
    const existing = this._labels.get(nodeId) ?? new Set();
    tags.forEach(t => existing.add(t));
    this._labels.set(nodeId, existing);
    return this;
  }

  // Add a BIM measurement
  addMeasurement(id, nodeAId, nodeBId, type='distance', meta={}) {
    this._measurements.push({ id, nodeAId, nodeBId, type, meta });
    return this;
  }

  // Get all tags for a node
  tagsOf(nodeId) { return [...(this._labels.get(nodeId) ?? new Set())]; }

  // Find all nodes tagged with a role
  nodesWithTag(tag) {
    const out=[];
    this._labels.forEach((tags,id) => { if(tags.has(tag)) out.push(id); });
    return out;
  }

  // Validate all tagged nodes against registered plugin schemas
  validate(nodes) {
    const report={ warnings:[], errors:[], passed:0, failed:0 };
    for (const [pluginId, schema] of this._schemas) {
      if (!schema.validate) continue;
      for (const [nodeId, tags] of this._labels) {
        const node = nodes.get(nodeId);
        if (!node) continue;
        const result = schema.validate(node, [...tags]);
        report.warnings.push(...(result.warnings??[]).map(w=>`[${pluginId}/${nodeId}] ${w}`));
        report.errors.push  (...(result.errors  ??[]).map(e=>`[${pluginId}/${nodeId}] ${e}`));
        result.errors?.length ? report.failed++ : report.passed++;
      }
    }
    return report;
  }
}

// ─── Interaction layer ─────────────────────────────────────────────────────────
export class InteractionGraph {
  constructor() {
    this._triggers  = new Map(); // nodeId → [{event, actionId}]
    this._actions   = new Map(); // actionId → {type, payload}
    this._machines  = new Map(); // machineId → NIFStateMachine
    this._scripts   = new Map(); // scriptId → function(context)
    this._listeners = [];        // runtime event listeners
  }

  // Bind a trigger on a node (click, hover, gaze, proximity, time)
  onEvent(nodeId, event, actionId) {
    const list = this._triggers.get(nodeId) ?? [];
    list.push({ event, actionId });
    this._triggers.set(nodeId, list);
    return this;
  }

  // Register an action
  defineAction(id, type, payload={}) {
    this._actions.set(id, { type, payload });
    // type: 'goto_time' | 'show_node' | 'hide_node' | 'play_sequence' |
    //       'set_state' | 'run_script' | 'navigate_camera' | 'play_audio' |
    //       'open_url' | 'trigger_animation' | 'emit_social_event'
    return this;
  }

  // Register a deterministic state machine for a scene element
  addStateMachine(id, states, transitions, initial) {
    this._machines.set(id, new NIFStateMachine(states, transitions, initial));
    return this;
  }

  // Register a deterministic script (must be pure — same input → same output)
  addScript(id, fn) {
    if (typeof fn !== 'function') throw new Error('Script must be a function');
    this._scripts.set(id, fn);
    return this;
  }

  // Fire an event on a node — runtime calls this on user interaction
  fireEvent(nodeId, event, context={}) {
    const triggers = this._triggers.get(nodeId) ?? [];
    const matching = triggers.filter(t => t.event === event || t.event === '*');
    const results  = [];
    for (const t of matching) {
      const action = this._actions.get(t.actionId);
      if (!action) continue;
      results.push(this._executeAction(action, context));
    }
    return results;
  }

  _executeAction(action, context) {
    if (action.type === 'run_script') {
      const fn = this._scripts.get(action.payload.scriptId);
      if (fn) return fn(context);
    }
    // Other action types are dispatched to the runtime
    return { type: action.type, payload: action.payload };
  }

  // Tick all state machines
  tick(dt, inputs={}) {
    this._machines.forEach(m => m.tick(dt, inputs));
  }
}

// ─── Plugin Registry ──────────────────────────────────────────────────────────
export class NIFPluginRegistry {
  constructor() {
    this._plugins = new Map();
  }

  /**
   * Register an industry plugin.
   * @param {string} id        — unique plugin identifier (e.g. 'architecture', 'events')
   * @param {object} plugin    — { name, version, semantic, tags, uiComponents, validate }
   */
  register(id, plugin) {
    if (this._plugins.has(id)) {
      console.warn(`[NIFPluginRegistry] Plugin '${id}' already registered — overwriting`);
    }
    this._plugins.set(id, { ...plugin, id, registeredAt: Date.now() });
    return this;
  }

  get(id)      { return this._plugins.get(id) ?? null; }
  has(id)      { return this._plugins.has(id); }
  list()       { return [...this._plugins.values()]; }
  unregister(id) { this._plugins.delete(id); return this; }
}

// ─── Built-in plugins ─────────────────────────────────────────────────────────

export const PLUGIN_ARCHITECTURE = {
  name:    'Architecture & BIM',
  version: '1.0.0',
  tags: ['wall','beam','column','slab','door','window','roof','foundation',
         'load-bearing','non-load-bearing','fire-rated','insulated',
         'structural','mechanical','electrical','plumbing'],
  validate: (node, labels) => {
    const warnings=[], errors=[];
    if (labels.includes('load-bearing') && !labels.includes('structural'))
      warnings.push('Load-bearing element should also be tagged as structural');
    if (labels.includes('beam') && node.meta.span > 12)
      warnings.push(`Beam span ${node.meta.span}m exceeds typical 12m without check`);
    if (labels.includes('column') && !node.meta.material)
      errors.push('Column missing material specification');
    return { warnings, errors };
  },
};

export const PLUGIN_EVENTS = {
  name:    'Events & Experiences',
  version: '1.0.0',
  tags: ['ceremony','reception','speech','first_dance','cake_cutting',
         'first_kiss','toast','entrance','exit','vow','exchange_rings',
         'performance','highlight','emotional_peak','cinematic'],
  momentSchemas: {
    first_dance:    { emotion:'joyful',    cameraHint:'medium_close' },
    first_kiss:     { emotion:'intimate',  cameraHint:'close_up'     },
    speech:         { emotion:'varied',    cameraHint:'medium'       },
    cake_cutting:   { emotion:'celebratory',cameraHint:'wide'        },
    cinematic:      { emotion:'neutral',   cameraHint:'director'     },
  },
  validate: (node, labels) => {
    const warnings=[], errors=[];
    if (labels.includes('ceremony') && !node.meta.timestamp)
      warnings.push('Ceremony moment missing timestamp');
    return { warnings, errors };
  },
};

export const PLUGIN_COMMERCE = {
  name:    'Commerce & Products',
  version: '1.0.0',
  tags: ['product','variant','configurable','purchasable','sku','price',
         'colour_option','size_option','material_option','out_of_stock'],
  validate: (node, labels) => {
    const warnings=[], errors=[];
    if (labels.includes('purchasable') && !node.meta.sku)
      errors.push('Purchasable item missing SKU');
    if (labels.includes('price') && typeof node.meta.priceZAR !== 'number')
      errors.push('Price node missing priceZAR field');
    return { warnings, errors };
  },
};

export const PLUGIN_EDUCATION = {
  name:    'Education & Learning',
  version: '1.0.0',
  tags: ['concept','definition','step','prerequisite','assessment',
         'hint','example','misconception','key_point'],
  validate: (node, labels) => {
    const warnings=[], errors=[];
    if (labels.includes('assessment') && !node.meta.question)
      errors.push('Assessment node missing question');
    return { warnings, errors };
  },
};

// ─── The main NIF Graph ────────────────────────────────────────────────────────
export class NIFGraph {
  /**
   * The complete NIF scene graph — all 4 layers plus plugins.
   * @param {object} opts
   *   id:       string UUID
   *   title:    string
   *   vertical: string
   *   plugins:  string[] — plugin ids to activate
   */
  constructor(opts={}) {
    this.id         = opts.id      ?? crypto.randomUUID?.() ?? `nif-${Date.now()}`;
    this.title      = opts.title   ?? 'Untitled NIF';
    this.vertical   = opts.vertical?? 'generic';
    this.version    = '1.0.0';
    this.created    = Date.now();

    // The four layers
    this.spatial     = new Map();        // id → SpatialNode
    this.temporal    = new TemporalGraph();
    this.semantic    = new SemanticGraph();
    this.interaction = new InteractionGraph();

    // Plugin system
    this.plugins     = new NIFPluginRegistry();
    this._activePluings = new Set(opts.plugins ?? []);

    // Register built-ins
    this.plugins.register('architecture', PLUGIN_ARCHITECTURE);
    this.plugins.register('events',       PLUGIN_EVENTS);
    this.plugins.register('commerce',     PLUGIN_COMMERCE);
    this.plugins.register('education',    PLUGIN_EDUCATION);

    // Register active plugin schemas with semantic layer
    for (const pid of this._activePluings) {
      const p = this.plugins.get(pid);
      if (p?.validate) this.semantic.registerPlugin(pid, p);
    }

    // External asset registry — URLs to glTF, USD, LAS, video, etc.
    this._assets  = new Map(); // assetId → {type, url, mimeType, size, loaded}

    // Runtime state — deterministic, reproducible
    this._playhead = 0;
    this._playing  = false;
  }

  // ── Spatial API ────────────────────────────────────────────────────────────
  addNode(id, type, opts={}) {
    const node = new SpatialNode(id, type, opts);
    this.spatial.set(id, node);
    return node;
  }

  addMesh(id, assetUrl, opts={}) {
    const assetId = `asset-${id}`;
    this._assets.set(assetId, { type:'gltf', url:assetUrl, ...opts });
    return this.addNode(id, NODE_TYPE.MESH, {
      ...opts,
      assetRef: { type:'gltf', assetId },
    });
  }

  addDepthField(id, nifR2Key, opts={}) {
    return this.addNode(id, NODE_TYPE.DEPTH_FIELD, {
      ...opts,
      assetRef: { type:'nif', r2Key:nifR2Key },
    });
  }

  addPointCloud(id, lasUrl, opts={}) {
    const assetId = `asset-${id}`;
    this._assets.set(assetId, { type:'las', url:lasUrl });
    return this.addNode(id, NODE_TYPE.POINT_CLOUD, {
      ...opts,
      assetRef: { type:'las', assetId },
    });
  }

  addCamera(id, opts={}) {
    return this.addNode(id, NODE_TYPE.CAMERA, {
      ...opts,
      meta: {
        fovY:      opts.fovY   ?? 60,
        position:  opts.pos    ?? [0,0,5],
        target:    opts.target ?? [0,0,0],
        up:        opts.up     ?? [0,1,0],
        ...opts.meta,
      },
    });
  }

  // Parent/child hierarchy
  parent(childId, parentId) {
    const child=this.spatial.get(childId), parent=this.spatial.get(parentId);
    if (child && parent) {
      parent.addEdge(EDGE_TYPE.CHILD, childId);
      child.meta.parentId = parentId;
    }
    return this;
  }

  // ── Semantic API ───────────────────────────────────────────────────────────
  tag(nodeId, ...tags) {
    this.semantic.tag(nodeId, ...tags);
    const node = this.spatial.get(nodeId);
    if (node) node.addEdge(EDGE_TYPE.TAGGED_AS, tags[0], { tags });
    return this;
  }

  // ── Temporal API ──────────────────────────────────────────────────────────
  moment(t, tag, meta={}) {
    this.temporal.tagMoment(t, tag, meta);
    return this;
  }

  animate(nodeId, property, keyframes, opts={}) {
    const id = `anim-${nodeId}-${property}`;
    this.temporal.animate(id, nodeId, property, keyframes, opts.easing);
    return this;
  }

  // ── Interaction API ────────────────────────────────────────────────────────
  onClick(nodeId, actionId) {
    this.interaction.onEvent(nodeId, 'click', actionId);
    return this;
  }

  action(id, type, payload={}) {
    this.interaction.defineAction(id, type, payload);
    return this;
  }

  // ── Runtime ───────────────────────────────────────────────────────────────
  // Deterministic tick — same dt, same state, same output on every device
  tick(dt, inputs={}) {
    this._playhead += dt;
    const animUpdates = this.temporal.tick(dt);
    this.interaction.tick(dt, inputs);

    // Apply animation updates to spatial nodes
    animUpdates.forEach((props, nodeId) => {
      const node = this.spatial.get(nodeId);
      if (!node) return;
      if (props.position)  node.meta.position  = props.position;
      if (props.rotation)  node.meta.rotation  = props.rotation;
      if (props.scale)     node.meta.scale      = props.scale;
      if (props.opacity !== undefined) node.meta.opacity = props.opacity;
    });

    return { playhead:this._playhead, animUpdates };
  }

  play()  { this._playing=true; }
  pause() { this._playing=false; }
  seekTo(t) {
    this._playhead = t;
    this.temporal._t = t;
    return this.temporal.evaluate(t);
  }

  // Validate all semantics against active plugin schemas
  validate() {
    return this.semantic.validate(this.spatial);
  }

  // ── Serialisation ──────────────────────────────────────────────────────────
  toJSON() {
    const spatial=[];
    this.spatial.forEach(n=>spatial.push(n.toJSON()));
    return {
      id:this.id, title:this.title, vertical:this.vertical,
      version:this.version, created:this.created,
      spatial,
      moments:  this.temporal.timeline.toJSON(),
      sequences:[...this.temporal.sequences.entries()].map(([id,s])=>({id,...s})),
      assets:   [...this._assets.entries()].map(([id,a])=>({id,...a})),
      plugins:  [...this._activePluings],
    };
  }

  static fromJSON(data) {
    const g = new NIFGraph({ id:data.id, title:data.title, vertical:data.vertical, plugins:data.plugins });
    data.spatial?.forEach(n => {
      const node = new SpatialNode(n.id, n.type, n);
      g.spatial.set(n.id, node);
    });
    data.moments?.forEach(m => g.temporal.tagMoment(m.t, m.tag, m));
    data.assets?.forEach(a => g._assets.set(a.id, a));
    return g;
  }
}
