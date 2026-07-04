/**
 * NIF Vertical: Education
 * fumoca.co.za · © Fumoca Technologies
 *
 * Why educators choose NIF:
 * - Capture any real-world learning object in 3D
 * - AI generates learning outcomes and curriculum-aligned description
 * - Students explore from all angles on any device — no app, no install
 * - Annotation layers: labels, steps, quiz hotspots
 * - Print a physical replica of the learning object for tactile learning
 */
export const EDUCATION = {
  id: 'education', label: 'Education', icon: '📚', color: '#60c4ff',
  plugins: ['education'],
  cameraMode: 'orbit',
  tags: [
    'concept','component','label','step','prerequisite','assessment',
    'hint','example','key_point','interactive','quiz',
    'part_a','part_b','cross_section','scale_model',
  ],
  measurements: [],
  defaultLayers: ['subject','annotations','environment'],
  cameraPresets: [
    { id:'orbit',   label:'Explore',    icon:'🔄', mode:'orbit' },
    { id:'front',   label:'Front view', icon:'👀', mode:'orbit' },
    { id:'section', label:'Cross-section', icon:'✂️', mode:'orbit' },
  ],
  measurementDisplay: { units:'metric', showInViewer:false, annotateWalls:false },
};
