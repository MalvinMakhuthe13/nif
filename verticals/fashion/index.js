/**
 * NIF Vertical: Fashion
 * fumoca.co.za · © Fumoca Technologies
 *
 * Why fashion brands choose NIF:
 * - Turntable product capture — no studio rig needed
 * - AI generates product copy and fit notes
 * - Proxy video plays on Instagram/TikTok natively
 * - Garment layers: isolate product from background cleanly
 * - Print a miniature product mock-up or figurine wearing the garment
 */
export const FASHION = {
  id: 'fashion', label: 'Fashion', icon: '👗', color: '#f06aff',
  plugins: ['commerce'],
  cameraMode: 'turntable',
  tags: [
    'garment','top','bottom','dress','shoe','accessory','fabric','texture',
    'size_xs','size_s','size_m','size_l','size_xl','colour_option','sku','purchasable',
    'front','back','detail','label','care_instructions',
  ],
  measurements: ['chest_cm','waist_cm','hip_cm','length_cm','inseam_cm','shoulder_cm'],
  defaultLayers: ['garment','background'],
  cameraPresets: [
    { id:'turntable', label:'Turntable',  icon:'🔄', mode:'turntable' },
    { id:'front',     label:'Front',      icon:'👀', mode:'orbit'     },
    { id:'detail',    label:'Close-up',   icon:'🔍', mode:'orbit'     },
  ],
  measurementDisplay: { units:'metric', showInViewer:true, annotateWalls:false },
};
