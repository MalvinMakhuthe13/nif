/**
 * NIF Vertical: Generic
 * fumoca.co.za · © Fumoca Technologies
 *
 * Default for all captures that don't fit a specific vertical.
 * Full NIF feature set — layer separation, scene editor, 3D print,
 * AI description, embed SDK — all available.
 */
export const GENERIC = {
  id: 'generic', label: 'NIF Scene', icon: '✦', color: '#a594ff',
  plugins: [],
  cameraMode: 'orbit',
  tags: ['foreground','background','subject','environment','object','person','space'],
  measurements: [],
  defaultLayers: ['foreground','background'],
  cameraPresets: [
    { id:'orbit', label:'Orbit', icon:'🔄', mode:'orbit' },
    { id:'fly',   label:'Fly',   icon:'🚁', mode:'fly'   },
    { id:'walk',  label:'Walk',  icon:'🚶', mode:'walk'  },
  ],
  measurementDisplay: { units:'metric', showInViewer:false, annotateWalls:false },
};
