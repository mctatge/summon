const {contextBridge,ipcRenderer}=require('electron');
const invoke=(channel)=>(...args)=>ipcRenderer.invoke(`summon:${channel}`,...args);
const subscribe=channel=>callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on(channel,listener);return()=>ipcRenderer.removeListener(channel,listener);};
contextBridge.exposeInMainWorld('summon',{
  teachingRead:invoke('teaching-read'),teachingAction:invoke('teaching-action'),showTeachingExtension:invoke('teaching-extension'),
  detectWake:invoke('detect-wake'),verifySpeaker:invoke('verify-speaker'),beginEnrollment:invoke('begin-enrollment'),enrollSpeaker:invoke('enroll-speaker'),finishEnrollment:invoke('finish-enrollment'),cancelEnrollment:invoke('cancel-enrollment'),interpret:invoke('interpret'),localModelStatus:invoke('local-model-status'),
  searchMemory:invoke('knowledge-search'),remember:invoke('remember'),forget:invoke('forget'),saveRoutine:invoke('save-routine'),removeRoutine:invoke('remove-routine'),runRoutine:invoke('run-routine'),
  snapshot:invoke('snapshot'),command:invoke('command'),selectProject:invoke('select-project'),correctFile:invoke('correct-file'),
  openFile:invoke('open-file'),revealFile:invoke('reveal-file'),settings:invoke('settings'),addProject:invoke('add-project'),
  chooseModel:invoke('choose-model'),openLink:invoke('open-link'),transcribe:invoke('transcribe'),ask:invoke('ask'),
  workInFlight:invoke('work-in-flight'),groupWork:invoke('work-in-flight-group'),workInFlightSettings:invoke('work-in-flight-settings'),revealPlace:invoke('work-in-flight-reveal'),onWorkInFlight:subscribe('summon:work-in-flight'),
  markStanding:invoke('work-in-flight-mark'),
  workTree:invoke('work-tree'),visualRepository:invoke('visual-repository'),saveVisualGoal:invoke('visual-goal-save'),
  workRecovery:invoke('work-recovery'),setWorkRecoveryEnabled:invoke('work-recovery-enabled'),scanWorkRecovery:invoke('work-recovery-scan'),reviewWorkRecovery:invoke('work-recovery-review'),
  contextReasoning:invoke('context-reasoning'),setContextReasoningSettings:invoke('context-reasoning-settings'),
  agentSessions:invoke('agent-sessions'),agentSessionTrace:invoke('agent-session-trace'),openAgentSession:invoke('agent-session-open'),agentSessionsSettings:invoke('agent-sessions-settings'),onOpenPanel:subscribe('summon:open-panel'),launchAgent:invoke('agent-launch'),installClaudeHooks:invoke('claude-hooks-install'),claudeHooksStatus:invoke('claude-hooks-status'),
  usage:invoke('usage'),usageSettings:invoke('usage-settings'),routePreview:invoke('route-preview'),routeFeedback:invoke('route-feedback'),clearRoutingHistory:invoke('route-history-clear'),
  voiceState:invoke('voice-state'),showWindow:invoke('show-window'),onVoiceMode:subscribe('summon:voice-mode'),onUpdate:subscribe('summon:update'),onVoiceToggle:subscribe('summon:voice-toggle'),onEnrollSpeaker:subscribe('summon:enroll-speaker')
});
