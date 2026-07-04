/**
 * NIF Vertical: Agriculture
 * fumoca.co.za · © Fumoca Technologies
 *
 * Why agronomists choose NIF:
 * - Field capture from drone or ground level
 * - AI generates field inspection report from capture
 * - NDVI zone overlay from depth field colour channels
 * - Fly-through mode for aerial field review
 * - Share with clients as a video — no specialist app needed
 */
export const AGRICULTURE = {
  id: 'agriculture', label: 'Agriculture', icon: '🌾', color: '#6ddc7c',
  plugins: ['education'],
  cameraMode: 'fly',
  tags: [
    'crop','soil','irrigation','pest','disease','healthy','stressed',
    'yield_zone','ndvi_high','ndvi_low','boundary','equipment',
    'row','furrow','canopy','bare_soil','waterlogged',
  ],
  measurements: ['area_ha','ndvi','canopy_height_cm','plant_density_per_m2','row_spacing_cm'],
  defaultLayers: ['canopy','soil','infrastructure'],
  cameraPresets: [
    { id:'fly',      label:'Aerial',     icon:'🚁', mode:'fly'   },
    { id:'ground',   label:'Ground',     icon:'🌱', mode:'walk'  },
    { id:'overhead', label:'Plan view',  icon:'🗺️',  mode:'top'   },
  ],
  measurementDisplay: { units:'metric', showInViewer:true, annotateWalls:false },
};
