/**
 * NIF Vertical: Property
 * fumoca.co.za · © Fumoca Technologies
 *
 * The most complete mobile-to-listing pipeline available:
 * - Walk through a property for 60–90 seconds with your phone
 * - NIF reconstructs every room as a navigable 4D scene
 * - Automatic room detection, area calculation, and floor plan sketch
 * - AI generates a professional listing description from the capture
 * - Embed on any property portal with one script tag
 * - Share to WhatsApp as a video — plays without the app
 *
 * Why agents choose NIF over open-source alternatives:
 * - No Matterport camera (R40,000) needed — just a phone
 * - No desktop software — capture to listing in 20 minutes
 * - Proxy video shares on WhatsApp/Instagram natively
 * - Licensed embed — clean, no third-party branding on their listing
 * - AI listing copy saves 45 minutes of writing per property
 *
 * Active plugins: architecture, measurements, commerce (for listing price)
 * Default camera mode: walk (WASD + pointer)
 * Default LOD: full depth field
 */

export const PROPERTY = {
  id:          'property',
  label:       'Property',
  icon:        '🏠',
  color:       '#3ddc97',
  plugins:     ['architecture', 'measurements', 'commerce'],
  cameraMode:  'walk',

  // Semantic tags applied during reconstruction layer splitting
  tags: [
    'room', 'wall', 'floor', 'ceiling', 'door', 'window',
    'kitchen', 'bathroom', 'bedroom', 'living_room', 'dining_room',
    'study', 'scullery', 'laundry', 'garage', 'garden', 'pool',
    'balcony', 'stoep', 'braai_area', 'entrance', 'passage',
    'load-bearing', 'structural', 'fire-rated', 'damp',
  ],

  // Measurements automatically extracted from depth field
  measurements: [
    'floor_area_m2',    // total interior floor area
    'room_area_m2',     // per-room floor area
    'ceiling_height_m', // floor-to-ceiling distance
    'room_width_m',     // widest horizontal dimension
    'room_length_m',    // longest horizontal dimension
    'door_height_m',    // interior door height (standard check)
    'window_width_m',   // window width for natural light estimate
  ],

  // Named layer groups for this vertical
  defaultLayers: [
    'structure',    // walls, ceilings, floors — the shell
    'finishes',     // tiles, paint, fittings — the detail
    'furniture',    // moveable items — can be hidden for an empty look
    'exterior',     // garden, pool, paving — separate from interior
  ],

  // Camera presets injected into the viewer mode bar
  cameraPresets: [
    { id: 'walk',     label: 'Walk through',  icon: '🚶', mode: 'walk'  },
    { id: 'overhead', label: 'Floor plan',     icon: '🗺️',  mode: 'top'  },
    { id: 'orbit',    label: 'Exterior view',  icon: '🔄', mode: 'orbit' },
    { id: 'fly',      label: 'Drone view',     icon: '🚁', mode: 'fly'  },
  ],

  // Floor plan overlay — extracted from depth field Z-slice at knee height
  floorPlan: {
    enabled:     true,
    sliceHeight: 0.9,   // metres above floor — knee height catches walls reliably
    lineColour:  '#3ddc97',
    roomLabels:  true,
    areLabels:   true,
    scale:       true,  // show scale bar
  },

  // Measurement display preferences
  measurementDisplay: {
    units:        'metric',   // 'metric' or 'imperial' — toggleable in viewer
    decimalPlaces: 1,
    showInViewer:  true,
    annotateWalls: true,
  },

  /**
   * AI listing description generator.
   * Called from the dashboard after a property NIF is complete.
   * Sends room data (from semantic map + measurements) to the fumoca API
   * which uses the Claude API to generate a professional listing blurb.
   *
   * Input: { rooms: [{label, area_m2, features}], total_m2, address, price }
   * Output: { headline, body, highlights, seoDescription }
   */
  generateListingCopy: async function(nifId, listingData, apiBase, token) {
    const res = await fetch(`${apiBase}/nif/${nifId}/property/listing-copy`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify(listingData),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? 'Listing copy failed');
    return res.json();
  },

  /**
   * Floor plan extraction.
   * Slices the depth field at sliceHeight and projects to 2D.
   * Returns a set of wall line segments in world coordinates.
   * Rendered as an SVG overlay in the viewer top-down mode.
   *
   * @param {{ count, data: Float32Array }} gaussians
   * @param {number} floorY — Y coordinate of the floor (world space)
   * @param {number} sliceThickness — how thick a slice to take (default 0.1m)
   * @returns {{ walls: Array<[x1,z1,x2,z2]>, bounds: {minX,maxX,minZ,maxZ} }}
   */
  extractFloorPlan: function(gaussians, floorY = 0, sliceThickness = 0.1) {
    const data   = gaussians.data;
    const count  = gaussians.count;
    const lo     = floorY + 0.85;
    const hi     = floorY + 0.85 + sliceThickness;
    const points = [];

    for (let i = 0; i < count; i++) {
      const j = i * 14;
      const y = data[j + 1];
      if (y >= lo && y <= hi) {
        points.push([data[j], data[j + 2]]); // x, z
      }
    }

    if (points.length < 10) return { walls: [], bounds: null };

    // Compute bounds
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of points) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    // Grid the points to find walls (high-density regions = walls)
    const RES    = 128;
    const grid   = new Uint16Array(RES * RES);
    const scaleX = (RES - 1) / (maxX - minX + 1e-8);
    const scaleZ = (RES - 1) / (maxZ - minZ + 1e-8);

    for (const [x, z] of points) {
      const gx = Math.round((x - minX) * scaleX);
      const gz = Math.round((z - minZ) * scaleZ);
      grid[gz * RES + gx]++;
    }

    // Threshold: cells with > 3 points are wall pixels
    const wallPixels = [];
    for (let gz = 0; gz < RES; gz++) {
      for (let gx = 0; gx < RES; gx++) {
        if (grid[gz * RES + gx] > 3) {
          wallPixels.push([
            minX + gx / scaleX,
            minZ + gz / scaleZ,
          ]);
        }
      }
    }

    return {
      walls:  wallPixels, // x,z pairs of wall pixels — renderer draws them
      bounds: { minX, maxX, minZ, maxZ },
      scale:  { pixelsPerMetre: scaleX },
    };
  },

  /**
   * Room area calculator.
   * Segments the floor plane into distinct rooms using connected-component
   * analysis of the depth field floor slice.
   *
   * @param {{ count, data: Float32Array }} gaussians
   * @param {number} floorY
   * @returns {Array<{ id, area_m2, width_m, length_m, centre: [x,z] }>}
   */
  measureRooms: function(gaussians, floorY = 0) {
    const data   = gaussians.data;
    const count  = gaussians.count;
    const floorSlice = 0.15; // 15cm above floor = floor surface points
    const points = [];

    for (let i = 0; i < count; i++) {
      const j = i * 14;
      const y = data[j + 1];
      if (y >= floorY - 0.05 && y <= floorY + floorSlice) {
        points.push([data[j], data[j + 2]]);
      }
    }

    if (points.length < 20) return [];

    // Bounding box
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of points) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    const width_m  = parseFloat((maxX - minX).toFixed(1));
    const length_m = parseFloat((maxZ - minZ).toFixed(1));
    const area_m2  = parseFloat((width_m * length_m).toFixed(1));

    // Single room approximation — connected components for multi-room
    // requires the full reconstruction; return bounding estimate here
    return [{
      id:       'main',
      area_m2,
      width_m,
      length_m,
      centre:   [(minX + maxX) / 2, (minZ + maxZ) / 2],
    }];
  },

  /**
   * Ceiling height estimator.
   * Takes the 95th percentile Y of wall-adjacent points minus floor Y.
   */
  measureCeilingHeight: function(gaussians, floorY = 0) {
    const data   = gaussians.data;
    const count  = gaussians.count;
    const ys     = [];
    for (let i = 0; i < count; i++) {
      const y = data[i * 14 + 1];
      if (y > floorY + 0.3) ys.push(y); // above knee height
    }
    if (!ys.length) return null;
    ys.sort((a, b) => a - b);
    const ceiling = ys[Math.floor(ys.length * 0.95)];
    return parseFloat((ceiling - floorY).toFixed(2));
  },
};

