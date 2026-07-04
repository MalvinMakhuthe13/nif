/**
 * NIF Vertical: Mining
 * fumoca.co.za · © Fumoca Technologies
 *
 * Why mining companies choose NIF:
 * - Shaft and stope capture without specialist hardware
 * - AI generates inspection reports from capture data
 * - Fly-through mode for underground navigation
 * - Hazard annotation: water ingress, loose ground, blast zones
 * - Share with safety officers as a video — no specialist viewer needed
 */
export const MINING = {
  id: 'mining', label: 'Mining', icon: '⛏️', color: '#ffcc44',
  plugins: ['architecture'],
  cameraMode: 'fly',
  tags: [
    'shaft','tunnel','stope','ore','waste','pillar','support','hazard',
    'ventilation','water','equipment','blast_zone','surveyed',
    'high_grade','low_grade','void','fractured','stable',
  ],
  measurements: ['volume_m3','length_m','width_m','height_m','grade_gpt','depth_m'],
  defaultLayers: ['geology','infrastructure','void'],
  cameraPresets: [
    { id:'fly',      label:'Fly through', icon:'🚁', mode:'fly'   },
    { id:'overhead', label:'Plan view',   icon:'🗺️',  mode:'top'   },
    { id:'section',  label:'Section',     icon:'📐', mode:'orbit' },
  ],
  measurementDisplay: { units:'metric', showInViewer:true, annotateWalls:true },
};
