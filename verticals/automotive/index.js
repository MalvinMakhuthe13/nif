/**
 * NIF Vertical: Automotive
 * fumoca.co.za · © Fumoca Technologies
 *
 * Why dealers choose NIF over open-source alternatives:
 * - Full 360° exterior + interior + undercarriage in one capture
 * - AI generates vehicle listing copy and condition report
 * - Proxy video plays on AutoTrader/Facebook Marketplace natively
 * - Damage annotation with layer separation
 * - Print a scale model or collectible figurine from the same scan
 */
export const AUTOMOTIVE = {
  id: 'automotive', label: 'Automotive', icon: '🚗', color: '#ffaa44',
  plugins: ['commerce', 'architecture'],
  cameraMode: 'orbit',
  tags: [
    'exterior','interior','engine','wheel','door','bonnet','boot',
    'chassis','suspension','damage','panel','window','seat','dashboard',
    'variant','trim_level','colour_option','sku','odometer','vin',
  ],
  measurements: ['length_mm','width_mm','height_mm','wheelbase_mm','ground_clearance_mm'],
  defaultLayers: ['exterior','interior','undercarriage'],
  cameraPresets: [
    { id:'orbit',     label:'Full orbit',    icon:'🔄', mode:'orbit'  },
    { id:'exterior',  label:'Exterior',      icon:'🚗', mode:'orbit'  },
    { id:'interior',  label:'Interior',      icon:'🪑', mode:'walk'   },
    { id:'underside', label:'Undercarriage', icon:'🔩', mode:'fly'    },
  ],
  measurementDisplay: { units:'metric', showInViewer:true, annotateWalls:false },
};
