
'use strict';
const $=id=>document.getElementById(id), SONY=0x054c, DS=0x0ce6, EDGE=0x0df2, ACC_RES=8192, GYRO_RES=1024, USB_LEN=63;
const CAL={raw:null,gyro:null,accel:null,firmware:null,featureReports:new Map()};
const S={device:null,link:'unknown',running:false,frozen:false,recording:false,calibrated:false,chartTimes:[],bias:{x:0,y:0,z:0},filter:{x:0,y:0,z:0,init:false},prev:{x:0,y:0,z:0},lastT:null,peakVel:0,peakAcc:0,samples:0,lastDt:0,angularAcceleration:0,history:[],csv:[],csvRows:0,rxCount:0,rxHz:0,rateWindowStart:0,displayPending:false,lastDisplayRow:null,pendingChartRows:[],gyroOff:false,profileVel:[],profileSensX:[],profileSensY:[],profileZones:{low:0,ramp:0,max:0}};
const HID={capturing:false,count:0,byId:new Map(),lastId:null,lastLen:0,rxCount:0,rxHz:0,rateWindowStart:0,ids:new Map(),live:{id:0,bytes:null,hex:'',dirty:false},candidateTimer:0};
const UI={raf:0,lastFrame:0,frameMs:33};
const PARSER={gyroOffset:null,accelOffset:null};
const cfg=()=>({deadzone:Math.max(0,+$('deadzone').value||0),velThreshold:Math.max(0,+$('velThreshold').value||0),accThreshold:Math.max(0,+$('accThreshold').value||0),historySize:Math.min(5000,Math.max(50,+$('historySize').value||600)),alpha:Math.min(1,Math.max(.01,+$('filterAlpha').value||.25)),filter:$('filterEnabled').checked,threshold:$('thresholdEnabled').checked});
function s16(lo,hi){const v=(hi<<8)|lo;return v>0x7fff?v-0x10000:v} function mag(v){return Math.hypot(v.x,v.y,v.z)} function dz(v,d){return Math.abs(v)<d?0:v} function fmt(v,n=2){return Number.isFinite(v)?v.toFixed(n):'0.00'}
function showStatus(t,live=false,warn=false){$('status').textContent=t;$('dot').className='dot'+(live?' live':'')+(warn?' warn':'')}
function banner(t){$('banner').textContent=t;$('banner').classList.toggle('show',!!t)}
function orientation(a){return {pitch:Math.atan2(-a.x,Math.hypot(a.y,a.z))*180/Math.PI,roll:Math.atan2(a.y,a.z)*180/Math.PI}}
function renderLive(p=S.processed||{x:0,y:0,z:0},a=S.accel||{x:0,y:0,z:0},o=S.orientation||{pitch:0,roll:0}){
  $('rawX').textContent=fmt(S.raw?.x);$('rawY').textContent=fmt(S.raw?.y);$('rawZ').textContent=fmt(S.raw?.z);
  $('procX').textContent=fmt(p.x);$('procY').textContent=fmt(p.y);$('procZ').textContent=fmt(p.z);$('velMag').textContent=fmt(mag(p));
  $('angAcc').textContent=fmt(S.angularAcceleration);$('peakVel').textContent=fmt(S.peakVel);$('peakAcc').textContent=fmt(S.peakAcc);
  $('accX').textContent=fmt(a.x,3);$('accY').textContent=fmt(a.y,3);$('accZ').textContent=fmt(a.z,3);$('accMag').textContent=fmt(mag(a),3);
  $('pitch').textContent=fmt(o.pitch);$('roll').textContent=fmt(o.roll);$('samples').textContent=S.samples;$('dt').textContent=fmt(S.lastDt,1);
  $('csvRows').textContent=S.csvRows;$('calibrated').textContent=S.calibrated?'Yes':'No';$('rate').textContent=S.rxHz+' Hz';
}
function percentile(values,p){
  if(!values.length)return 0;
  const a=[...values].sort((x,y)=>x-y), idx=(a.length-1)*p, lo=Math.floor(idx), hi=Math.ceil(idx);
  return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(idx-lo);
}
function updateAimingProfile(){
  const turns=HEAT.turns||[], angles=turns.map(t=>Math.hypot(t.x,t.y)), left=turns.filter(t=>t.x<0).length, right=turns.filter(t=>t.x>0).length;
  const validLR=left+right, vel=S.profileVel||[], sensX=S.profileSensX||[], sensY=S.profileSensY||[], zones=S.profileZones||{low:0,ramp:0,max:0};
  const med=percentile(angles,.5), p90=percentile(angles,.9), p95=percentile(angles,.95), max=angles.length?Math.max(...angles):0;
  const vm=percentile(vel,.5), vp90=percentile(vel,.9), vp95=percentile(vel,.95), vmax=vel.length?Math.max(...vel):0;
  const sxm=percentile(sensX,.5), sx90=percentile(sensX,.9), sym=percentile(sensY,.5), sy90=percentile(sensY,.9);
  const ztotal=zones.low+zones.ramp+zones.max, pct=v=>ztotal?100*v/ztotal:0;
  $('profileTurns').textContent=turns.length; $('profileMedianTurn').textContent=fmt(med,1)+'°'; $('profileP90Turn').textContent=fmt(p90,1)+'°'; $('profileP95Turn').textContent=fmt(p95,1)+'°'; $('profileMaxTurn').textContent=fmt(max,1)+'°';
  $('profileLeftRight').textContent=(validLR?(left/validLR*100):0).toFixed(1)+'% / '+(validLR?(right/validLR*100):0).toFixed(1)+'%';
  $('profileMedianVel').textContent=fmt(vm,1)+' °/s'; $('profileP90Vel').textContent=fmt(vp90,1)+' °/s'; $('profileP95Vel').textContent=fmt(vp95,1)+' °/s'; $('profileMaxVel').textContent=fmt(vmax,1)+' °/s';
  $('profileMedianSensX').textContent=fmt(sxm,2)+'×'; $('profileP90SensX').textContent=fmt(sx90,2)+'×'; $('profileMedianSensY').textContent=fmt(sym,2)+'×'; $('profileP90SensY').textContent=fmt(sy90,2)+'×';
  $('profileSensZones').textContent=`${pct(zones.low).toFixed(1)}% / ${pct(zones.ramp).toFixed(1)}% / ${pct(zones.max).toFixed(1)}%`;
  const rampPct=pct(zones.ramp), minX=JSM.loaded?Math.min(JSM.minSens.x,JSM.maxSens.x):0, minY=JSM.loaded?Math.min(JSM.minSens.y,JSM.maxSens.y):0;
  const inconsistent=JSM.loaded && rampPct>50 && sensX.length && sensY.length && Math.abs(sxm-minX)<0.005 && Math.abs(sym-minY)<0.005;
  $('profileSummary').textContent=turns.length?`Profile uses ${turns.length} completed turns and ${vel.length.toLocaleString()} active IMU samples (up to ~16.7 min at 1000 Hz). Velocity uses the same processed magnitude written to CSV. Sensitivity is reported separately for horizontal (X) and vertical (Y). Low / ramp / max is time-weighted from IMU sample duration using the loaded JSM MIN/MAX_GYRO_THRESHOLD values. GYRO_OFF is excluded.${inconsistent?' ⚠ Consistency warning: most time is in the sensitivity ramp but both median sensitivities equal their configured minima; inspect the loaded JSM configuration or telemetry.':''}`:'Play a session to build an aiming profile. GYRO_OFF samples are excluded.';
}
function profileZone(speed){
  if(!JSM.loaded)return 'ramp';
  if(JSM.maxThreshold>JSM.minThreshold){if(speed<=JSM.minThreshold)return 'low';if(speed>=JSM.maxThreshold)return 'max';return 'ramp'}
  return 'ramp';
}
function savedRuns(){try{return JSON.parse(localStorage.getItem('gyroDashboardRuns')||'[]')}catch{return []}}
function renderRuns(){
  const body=$('runCompareBody'), runs=savedRuns(); if(!body)return;
  if(!runs.length){body.innerHTML='<tr><td colspan="9" style="text-align:left">No saved runs yet.</td></tr>';return}
  body.innerHTML=runs.map((r,i)=>`<tr><td>${new Date(r.time).toLocaleString()}</td><td>${Number.isFinite(r.accuracy)?r.accuracy.toFixed(2)+'%':'—'}</td><td>${r.turns}</td><td>${fmt(r.medianTurn,1)}°</td><td>${fmt(r.p90Turn,1)}°</td><td>${fmt(r.medianVel,1)} °/s</td><td>${fmt(r.p90Vel,1)} °/s</td><td>${fmt(r.medianSensX,2)}× / ${fmt(r.medianSensY,2)}×</td><td><button class="deleteRun" data-i="${i}">Delete</button></td></tr>`).join('');
  body.querySelectorAll('.deleteRun').forEach(b=>b.onclick=()=>{const a=savedRuns();a.splice(+b.dataset.i,1);localStorage.setItem('gyroDashboardRuns',JSON.stringify(a));renderRuns()});
}
function saveCurrentRun(){
  const turns=HEAT.turns||[], angles=turns.map(t=>Math.hypot(t.x,t.y)), vel=S.profileVel||[];
  if(!turns.length||!vel.length){banner('Play a session before saving a comparison run.');return}
  const av=parseFloat($('runAccuracy').value), run={time:new Date().toISOString(),accuracy:Number.isFinite(av)?av:null,turns:turns.length,medianTurn:percentile(angles,.5),p90Turn:percentile(angles,.9),p95Turn:percentile(angles,.95),maxTurn:Math.max(...angles),medianVel:percentile(vel,.5),p90Vel:percentile(vel,.9),p95Vel:percentile(vel,.95),medianSensX:percentile(S.profileSensX||[],.5),medianSensY:percentile(S.profileSensY||[],.5),config:JSM.name||''};
  const runs=savedRuns();runs.push(run);localStorage.setItem('gyroDashboardRuns',JSON.stringify(runs.slice(-50)));renderRuns();banner('Aiming run saved locally for comparison.');setTimeout(()=>banner(''),1800);
}
function addHistory(r){const max=cfg().historySize;S.history.push(r);if(S.history.length>max)S.history.splice(0,S.history.length-max)}
function renderHistory(){const b=$('historyBody');const frag=document.createDocumentFragment();for(const x of S.history.slice(-120).reverse()){const tr=document.createElement('tr');[new Date(x.timestamp).toLocaleTimeString(),fmt(x.gx),fmt(x.gy),fmt(x.gz),fmt(x.vm),fmt(x.aa),fmt(x.ax,3),fmt(x.ay,3),fmt(x.az,3),fmt(x.pitch),fmt(x.roll)].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.appendChild(td)});frag.appendChild(tr)}b.replaceChildren(frag)}
function scheduleUI(row){S.lastDisplayRow=row;if(S.displayPending||S.frozen)return;S.displayPending=true;requestAnimationFrame(flushUI)}
function flushUI(){S.displayPending=false;const row=S.lastDisplayRow;if(!row)return;renderLive(S.processed,S.accel,S.orientation);renderHistory();while(S.pendingChartRows.length)charts(S.pendingChartRows.shift(),true);const entries=[...SH.bins.entries()].sort((a,b)=>a[0]-b[0]);sChart.data.labels=entries.map(x=>x[0].toFixed(2));sChart.data.datasets[0].data=entries.map(x=>x[1]);updateVelocityScale();vChart.update('none');aChart.update('none');sChart.update('none');stChart.update('none');updateAimingProfile();if(HID.live.dirty){$('hidHex').textContent=HID.live.hex;HID.live.dirty=false}}

const header=['timestamp','rawGyroX_deg_s','rawGyroY_deg_s','rawGyroZ_deg_s','processedGyroX_deg_s','processedGyroY_deg_s','processedGyroZ_deg_s','velocityMagnitude_deg_s','angularAcceleration_deg_s2','accelerometerX_g','accelerometerY_g','accelerometerZ_g','accelerometerMagnitude_g','pitch_deg','roll_deg','effectiveSensitivity','accelerationMultiplier'];
function esc(v){const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s}
function csv(r){if(!S.recording)return;S.csv.push(header.map(k=>esc(r[k])).join(','));S.csvRows++}
function download(){if(!S.csvRows)return;const b=new Blob([[header.join(','),...S.csv].join('\n')],{type:'text/csv'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='dualsense-imu-'+new Date().toISOString().replaceAll(':','-')+'.csv';a.click();URL.revokeObjectURL(a.href)}

// JoyShockMapper configuration parser and processor.
const JSM={loaded:false,name:'',values:{},rawText:'',warnings:[],gyroOffBindings:[],
  gyroSens:{x:0,y:0},minSens:{x:0,y:0},maxSens:{x:0,y:0},minThreshold:0,maxThreshold:0,
  cutoff:0,axisX:'STANDARD',axisY:'STANDARD',mouseX:'Y',mouseY:'X',
  realWorldCalibration:40,inGameSens:1,
  acceleration:false,accelMultiplier:1,accelLower:0,accelUpper:75
};
function nums(v){return (v.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g)||[]).map(Number)}
function pair(v,def=0){const n=nums(v);return {x:Number.isFinite(n[0])?n[0]:def,y:Number.isFinite(n[1])?n[1]:(Number.isFinite(n[0])?n[0]:def)}}
function splitBindingExpr(v){return v.split(/\s+/).map(x=>x.trim().toUpperCase()).filter(Boolean).map(x=>x.replace(/^['"]|['"]$/g,''));}
function parseJSM(text,name){
  const out={...JSM,loaded:true,name,values:{},rawText:text,warnings:[]};
  for(const original of text.split(/\r?\n/)){
    const line=original.replace(/#.*$/,'').trim(); if(!line)continue;
    const m=line.match(/^([^=]+?)\s*=\s*(.*)$/); if(!m)continue;
    const key=m[1].trim().toUpperCase(), val=m[2].trim(); out.values[key]=val;
    const valueTokens=splitBindingExpr(val);
    if(key==='GYRO_SENS') out.gyroSens=pair(val);
    else if(key==='GYRO_OFF') out.gyroOffBindings=splitBindingExpr(val);
    else if(valueTokens.includes('GYRO_OFF')) out.gyroOffBindings=splitBindingExpr(key.replace(/,/g,' '));
    else if(key==='MIN_GYRO_SENS') out.minSens=pair(val);
    else if(key==='MAX_GYRO_SENS') out.maxSens=pair(val);
    else if(key==='MIN_GYRO_THRESHOLD') out.minThreshold=nums(val)[0]||0;
    else if(key==='MAX_GYRO_THRESHOLD') out.maxThreshold=nums(val)[0]||0;
    else if(key==='GYRO_CUTOFF_SPEED') out.cutoff=nums(val)[0]||0;
    else if(key==='REAL_WORLD_CALIBRATION') out.realWorldCalibration=nums(val)[0]??40;
    else if(key==='IN_GAME_SENS') out.inGameSens=nums(val)[0]??1;
    else if(key==='GYRO_AXIS_X') out.axisX=val.toUpperCase();
    else if(key==='GYRO_AXIS_Y') out.axisY=val.toUpperCase();
    else if(key==='MOUSE_X_FROM_GYRO_AXIS') out.mouseX=val.toUpperCase();
    else if(key==='MOUSE_Y_FROM_GYRO_AXIS') out.mouseY=val.toUpperCase();
    else if(key==='GYRO_ACCELERATION') out.acceleration=/^(1|TRUE|ON|YES)$/i.test(val);
    else if(key==='GYRO_ACCEL_MULTIPLIER') out.accelMultiplier=nums(val)[0]??1;
    else if(key==='GYRO_ACCEL_LOWER_THRESH' || key==='GYRO_ACCEL_LOWER_THRESHOLD') out.accelLower=nums(val)[0]??0;
    else if(key==='GYRO_ACCEL_UPPER_THRESH' || key==='GYRO_ACCEL_UPPER_THRESHOLD') out.accelUpper=nums(val)[0]??75;
  }
  if('GYRO_SENS' in out.values){out.minSens={...out.gyroSens};out.maxSens={...out.gyroSens};out.minThreshold=0;out.maxThreshold=0}
  if(!('GYRO_ACCELERATION' in out.values) && ('GYRO_ACCEL_MULTIPLIER' in out.values || 'GYRO_ACCEL_LOWER_THRESH' in out.values || 'GYRO_ACCEL_UPPER_THRESH' in out.values)) out.acceleration=true;
  return out;
}
function effectiveSens(speed,axis='x'){
  if(!JSM.loaded)return 1;
  const i=axis==='y'?1:0;
  let lo=JSM.minSens[axis==='y'?'y':'x'], hi=JSM.maxSens[axis==='y'?'y':'x'];
  if(JSM.values.GYRO_SENS!==undefined){lo=hi=JSM.gyroSens[axis==='y'?'y':'x']}
  if(JSM.maxThreshold>JSM.minThreshold){
    if(speed<=JSM.minThreshold)return lo;
    if(speed>=JSM.maxThreshold)return hi;
    const t=(speed-JSM.minThreshold)/(JSM.maxThreshold-JSM.minThreshold); return lo+(hi-lo)*t;
  }
  if(JSM.minSens[axis==='y'?'y':'x']!==0 || JSM.maxSens[axis==='y'?'y':'x']!==0) return speed<=JSM.minThreshold?lo:hi;
  return 1;
}
function accelerationMultiplier(speed){
  if(!JSM.loaded || !JSM.acceleration)return 1;
  const lo=JSM.accelLower,hi=Math.max(lo+1e-6,JSM.accelUpper);
  const t=Math.max(0,Math.min(1,(speed-lo)/(hi-lo)));
  return 1+(JSM.accelMultiplier-1)*t;
}
function processJSM(raw,speed){
  if(!JSM.loaded)return {x:raw.x,y:raw.y,z:raw.z,sens:1,accelMult:1,sx:raw.x,sy:raw.y,mouseX:raw.x,mouseY:raw.y,cameraX:raw.x,cameraY:raw.y};
  let x=raw.x,y=raw.y,z=raw.z;
  // JoyShockMapper can remap which physical gyro axis drives mouse X/Y. Keep Z visible,
  // while applying the corresponding horizontal/vertical sensitivity to the selected axes.
  const sx=effectiveSens(speed,'x'), sy=effectiveSens(speed,'y'), am=accelerationMultiplier(speed);
  const mapped={x:x,y:y,z:z};
  const xAxis=JSM.mouseX, yAxis=JSM.mouseY;
  const read=a=>a==='X'?x:a==='Y'?y:a==='Z'?z:0;
  const write=(a,v)=>{if(a==='X')mapped.x=v;else if(a==='Y')mapped.y=v;else if(a==='Z')mapped.z=v};
  if(xAxis!=='NONE')write(xAxis,read(xAxis)*(JSM.axisX==='INVERTED'?-1:1)*sx*am);
  if(yAxis!=='NONE')write(yAxis,read(yAxis)*(JSM.axisY==='INVERTED'?-1:1)*sy*am);
  if(JSM.cutoff>0 && speed<JSM.cutoff){mapped.x=0;mapped.y=0;mapped.z=0}
  // JSM semantics for a calibrated 3D mouse-look game:
  //   camera velocity (deg/s) = physical gyro velocity (deg/s) × GYRO_SENS
  //   mouse output (mouse units/s) = camera velocity × REAL_WORLD_CALIBRATION / IN_GAME_SENS
  // IN_GAME_SENS is deliberately divided out by JSM because the game multiplies the
  // injected mouse movement by that sensitivity again. Therefore RWC/IN_GAME_SENS
  // changes the mouse movement JSM emits, but does NOT change the intended camera angle
  // when REAL_WORLD_CALIBRATION is correct. This is not an algebraic round-trip: camera
  // velocity is the JSM target, and mouse output is derived from that target.
  const rwc=Number.isFinite(JSM.realWorldCalibration)&&JSM.realWorldCalibration>0?JSM.realWorldCalibration:40;
  const igs=Number.isFinite(JSM.inGameSens)&&JSM.inGameSens>0?JSM.inGameSens:1;
  const calibrationFactor=rwc/igs;
  let cameraX=xAxis==='NONE'?0:read(xAxis)*(JSM.axisX==='INVERTED'?-1:1)*sx*am;
  let cameraY=yAxis==='NONE'?0:read(yAxis)*(JSM.axisY==='INVERTED'?-1:1)*sy*am;
  if(JSM.cutoff>0 && speed<JSM.cutoff){cameraX=0;cameraY=0}
  const mouseX=cameraX*calibrationFactor, mouseY=cameraY*calibrationFactor;
  return {x:mapped.x,y:mapped.y,z:mapped.z,sens:(sx+sy)/2,accelMult:am,sx,sy,mouseX,mouseY,cameraX,cameraY,calibrationFactor};
}
function renderJSM(){
  $('jsmName').textContent=JSM.loaded?JSM.name:'Not loaded';
  $('jsmSens').textContent=JSM.loaded?`${JSM.minSens.x}/${JSM.minSens.y} → ${JSM.maxSens.x}/${JSM.maxSens.y}`:'—';
  $('jsmThresh').textContent=JSM.loaded?`${JSM.minThreshold} → ${JSM.maxThreshold}°/s`:'—';
  $('jsmAccel').textContent=JSM.loaded?(JSM.acceleration?`${JSM.accelMultiplier}× @ ${JSM.accelLower}–${JSM.accelUpper}°/s`:'Off'):'—';
  $('jsmGyroOff').textContent=JSM.loaded?(JSM.gyroOffBindings.length?JSM.gyroOffBindings.join(' + '):'Not configured'):'Not configured';
  const calFactor=JSM.loaded&&JSM.inGameSens>0?JSM.realWorldCalibration/JSM.inGameSens:null;
  const calText=JSM.loaded?`RWC ${JSM.realWorldCalibration} · In-game sens ${JSM.inGameSens} · ${calFactor.toFixed(3)} mouse units/°`:'RWC — · In-game sens —';
  const calMetric=$('jsmCalibration'); if(calMetric)calMetric.textContent=calText;
  $('jsmSummary').textContent=JSM.loaded?`Loaded ${JSM.name}. Effective sensitivity is interpolated between the configured gyro thresholds; acceleration modifier ${JSM.acceleration?'is enabled':'is disabled'}. Mouse X ← ${JSM.mouseX}, mouse Y ← ${JSM.mouseY}. GYRO_SENS directly defines the intended in-game camera ratio (1× = 1° camera per 1° controller). REAL_WORLD_CALIBRATION / IN_GAME_SENS converts that intended camera motion into mouse output; IN_GAME_SENS is compensated by JSM rather than multiplying the camera-angle estimate.${JSM.gyroOffBindings.length?' GYRO_OFF ← '+JSM.gyroOffBindings.join(' + ')+'. Touch contact is supported.':''}`:'Load a JoyShockMapper config to apply its gyro sensitivity curve and acceleration modifiers to the live IMU stream.';
  updateSensitivityTimelineScale();
  stChart.update('none');
}
$('loadJsm').onclick=()=>$('jsmFile').click();
$('jsmFile').onchange=async e=>{const files=[...e.target.files];if(!files.length)return;let combined='';for(const f of files)combined+='\n# '+f.name+'\n'+await f.text();JSM.loaded=false;Object.assign(JSM,parseJSM(combined,files.length===1?files[0].name:`${files.length} config files`));renderJSM();banner(`Loaded JoyShockMapper config: ${JSM.name}`);};

const vChart=new Chart($('velocityChart'),{type:'line',data:{labels:[],datasets:[
 {label:'Raw X',data:[],pointRadius:0,borderWidth:1,borderDash:[5,4]},
 {label:'Raw Y',data:[],pointRadius:0,borderWidth:1,borderDash:[5,4]},
 {label:'Raw Z',data:[],pointRadius:0,borderWidth:1,borderDash:[5,4]},
 {label:'Processed X',data:[],pointRadius:0,borderWidth:1.8},
 {label:'Processed Y',data:[],pointRadius:0,borderWidth:1.8},
 {label:'Processed Z',data:[],pointRadius:0,borderWidth:1.8}]},options:{responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{display:false},y:{min:-300,max:300,title:{display:true,text:'deg/s / camera deg/s'}}}}});
const aChart=new Chart($('accelerationChart'),{type:'line',data:{labels:[],datasets:[{label:'|α|',data:[],pointRadius:0,borderWidth:1.5}]},options:{responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{display:false},y:{title:{display:true,text:'deg/s²'}}}}});
const sChart=new Chart($('sensitivityChart'),{type:'bar',data:{labels:[],datasets:[{label:'Time',data:[],borderWidth:1}]},options:{responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{title:{display:true,text:'Effective sensitivity ×'}},y:{title:{display:true,text:'Seconds'}}}}});
const CHART_WINDOW_MS=30000;
const stChart=new Chart($('sensitivityTimelineChart'),{type:'line',data:{labels:[],datasets:[{label:'Effective sensitivity',data:[],pointRadius:0,borderWidth:1.5}]},options:{responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{display:true,ticks:{maxTicksLimit:8,autoSkip:true}},y:{title:{display:true,text:'Sensitivity ×'}}}}});
function updateSensitivityTimelineScale(){
  const y=stChart.options.scales.y;
  if(!JSM.loaded){ y.min=0; y.max=2; return; }
  const vals=[];
  for(const axis of ['x','y']){
    const lo=Number(JSM.minSens?.[axis]);
    const hi=Number(JSM.maxSens?.[axis]);
    if(Number.isFinite(lo)) vals.push(lo);
    if(Number.isFinite(hi)) vals.push(hi);
  }
  if(JSM.values?.GYRO_SENS!==undefined){
    const g=Number(JSM.gyroSens?.x);
    if(Number.isFinite(g)) vals.push(g);
    const gy=Number(JSM.gyroSens?.y);
    if(Number.isFinite(gy)) vals.push(gy);
  }
  if(!vals.length){y.min=0;y.max=2;return;}
  let lo=Math.min(...vals), hi=Math.max(...vals);
  if(Math.abs(hi-lo)<1e-9){ const pad=Math.max(0.1,Math.abs(hi)*0.15); lo=Math.max(0,hi-pad); hi=hi+pad; }
  else { const pad=(hi-lo)*0.1; lo=Math.max(0,lo-pad); hi+=pad; }
  y.min=Math.floor(lo*20)/20; y.max=Math.ceil(hi*20)/20;
}
const HEAT={size:41,grid:null,peak:1,lastDraw:0,maxAngle:100,turns:[],active:{x:0,y:0,ms:0,moving:false},lastMove:false,scalePercentile:0.90};
function heatSensitivityRatio(){
  if(!JSM.loaded)return 1;
  const x=Number(JSM.maxSens?.x ?? JSM.gyroSens?.x), y=Number(JSM.maxSens?.y ?? JSM.gyroSens?.y);
  if(Number.isFinite(x)&&x>0&&Number.isFinite(y)&&y>0)return y/x;
  return 1;
}
function heatYScale(){return HEAT.maxAngle*heatSensitivityRatio()}
function heatCellIndex(dx,dy,xScale=HEAT.maxAngle,yScale=heatYScale()){const nx=-dx/xScale, ny=dy/yScale; if(!Number.isFinite(nx)||!Number.isFinite(ny)||nx*nx+ny*ny>1)return -1; const gx=Math.min(HEAT.size-1,Math.max(0,Math.floor((nx+1)*0.5*HEAT.size))); const gy=Math.min(HEAT.size-1,Math.max(0,Math.floor((1-(ny+1)*0.5)*HEAT.size))); return gy*HEAT.size+gx;}
function rebuildHeatGrid(){
  HEAT.grid=new Float32Array(HEAT.size*HEAT.size); HEAT.peak=1;
  for(const t of HEAT.turns){const i=heatCellIndex(t.x,t.y); if(i>=0){HEAT.grid[i]+=1;HEAT.peak=Math.max(HEAT.peak,HEAT.grid[i]);}}
}
function updateHeatScale(){
  // Scale to the dense part of the turn distribution instead of rare outliers.
  // The 90th percentile keeps roughly 90% of completed turns visible at useful resolution.
  if(HEAT.turns.length<10){HEAT.maxAngle=100;return;}
  const ratio=Math.max(0.05,heatSensitivityRatio());
  const extents=HEAT.turns.map(t=>Math.hypot(t.x,t.y/ratio)).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!extents.length){HEAT.maxAngle=100;return;}
  const pos=(extents.length-1)*HEAT.scalePercentile, lo=Math.floor(pos), hi=Math.ceil(pos);
  const q=lo===hi?extents[lo]:extents[lo]+(extents[hi]-extents[lo])*(pos-lo);
  HEAT.maxAngle=Math.max(50,Math.ceil(q/10)*10);
}
function turnBinEdges(maxAngle){
  // Keep the dense aiming region detailed regardless of occasional large turns.
  // 0–50°: 5° bins; 50–100°: 10°; 100–200°: 20°;
  // 200–400°: 25°; 400–800°: 50°; beyond: 100°.
  const edges=[0];
  const add=(limit,width)=>{while(edges[edges.length-1] < Math.min(limit,maxAngle)){edges.push(Math.min(limit,edges[edges.length-1]+width));}};
  add(50,5); add(100,10); add(200,20); add(400,25); add(800,50);
  while(edges[edges.length-1] < maxAngle)edges.push(edges[edges.length-1]+100);
  if(edges.length===1)edges.push(5);
  if(edges[edges.length-1] < maxAngle)edges.push(maxAngle);
  return edges;
}
function renderTurnDistribution(){
  const bins=$('turnBins'), total=$('turnDistTotal'); if(!bins||!total)return;
  const turns=HEAT.turns, n=turns.length; total.textContent=`${n} completed turn${n===1?'':'s'}`;
  if(!n){bins.innerHTML='<div class="turn-dist-empty">No completed turns yet.</div>';return;}
  const maxObserved=Math.max(...turns.map(t=>Math.hypot(t.x,t.y)),0);
  const edges=turnBinEdges(maxObserved);
  const counts=new Array(edges.length-1).fill(0);
  for(const t of turns){
    const a=Math.hypot(t.x,t.y);
    let idx=edges.length-2;
    for(let i=0;i<edges.length-1;i++){if(a>=edges[i] && (a<edges[i+1] || i===edges.length-2)){idx=i;break;}}
    counts[idx]++;
  }
  const maxPct=Math.max(...counts.map(c=>c/n),0);
  const frag=document.createDocumentFragment();
  counts.forEach((count,i)=>{const lo=edges[i],hi=edges[i+1],pct=count/n*100;const row=document.createElement('div');row.className='turn-bin';
    const label=document.createElement('div');label.className='turn-bin-label';label.textContent=`${lo}–${hi}°`;
    const track=document.createElement('div');track.className='turn-bin-track';const fill=document.createElement('div');fill.className='turn-bin-fill';fill.style.width=(maxPct>0?Math.max(1,(pct/100)/maxPct*100):0)+'%';track.appendChild(fill);
    const value=document.createElement('div');value.className='turn-bin-pct';value.textContent=`${pct.toFixed(pct>=10?0:1)}% (${count})`;
    row.append(label,track,value);frag.appendChild(row);
  });
  bins.replaceChildren(frag);
}
function resetHeatmap(){HEAT.turns=[];HEAT.maxAngle=100;rebuildHeatGrid();HEAT.active={x:0,y:0,ms:0,moving:false};renderTurnDistribution();drawHeatmap();}
function commitHeatTurn(){
  const a=HEAT.active; const angle=Math.hypot(a.x,a.y); if(angle>=3){
    HEAT.turns.push({x:a.x,y:a.y}); if(HEAT.turns.length>3000)HEAT.turns.splice(0,HEAT.turns.length-3000); updateHeatScale(); rebuildHeatGrid(); renderTurnDistribution(); updateAimingProfile();
  }
  HEAT.active={x:0,y:0,ms:0,moving:false};
}
function addHeat(x,y,dt){
  if(S.gyroOff){if(HEAT.active.moving)commitHeatTurn();return;}
  const sx=Number.isFinite(x)?x:0, sy=Number.isFinite(y)?y:0, speed=Math.hypot(sx,sy), dms=Math.max(0,dt||0);
  const idle=speed<3;
  if(idle){
    if(HEAT.active.moving){HEAT.active.ms+=dms;if(HEAT.active.ms>=70)commitHeatTurn();}
    return;
  }
  if(HEAT.active.moving){
    const ax=HEAT.active.x, ay=HEAT.active.y; const prevDir=Math.atan2(ay,ax), nextDir=Math.atan2(sy,sx); let dd=Math.abs(Math.atan2(Math.sin(nextDir-prevDir),Math.cos(nextDir-prevDir)));
    if(Math.hypot(ax,ay)>12 && dd>Math.PI*0.82)commitHeatTurn();
  }
  HEAT.active.x+=sx*dms/1000; HEAT.active.y+=sy*dms/1000; HEAT.active.ms=0; HEAT.active.moving=true;
}
function drawHeatmap(){
  const c=$('gyroHeatmap'); if(!c)return; const ctx=c.getContext('2d'),w=c.width,h=c.height,cx=w/2,cy=h/2,r=Math.min(w,h)*.40;
  const ratio=heatSensitivityRatio(), yScale=HEAT.maxAngle*ratio;
  ctx.clearRect(0,0,w,h);ctx.save();ctx.translate(cx,cy);
  // The field stays circular, but X and Y have independent degree scales from JSM.
  // Thus a Y sensitivity of 0.5× X sensitivity gives Y a 0–50° scale when X is 0–100°.
  const rings=[]; for(let deg=50;deg<HEAT.maxAngle;deg+=50)rings.push(deg); rings.push(HEAT.maxAngle);
  ctx.font='12px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';
  for(const deg of rings){const rr=r*(deg/HEAT.maxAngle);ctx.beginPath();ctx.arc(0,0,rr,0,Math.PI*2);ctx.strokeStyle='#dce8f533';ctx.lineWidth=1;ctx.stroke();ctx.fillStyle='#b9c7d8';ctx.fillText(deg+'°',0,-rr-8);}
  // Horizontal rings/labels use the X scale; vertical labels show the corresponding Y scale.
  ctx.fillStyle='#8fa4bb';ctx.font='11px system-ui';ctx.textAlign='left';ctx.fillText(`X ±${HEAT.maxAngle}°`,-r,r+20);ctx.textAlign='right';ctx.fillText(`Y ±${yScale.toFixed(yScale%1?'1':'0')}°`,r,r+20);
  const cell=(r*2)/HEAT.size;
  for(let gy=0;gy<HEAT.size;gy++)for(let gx=0;gx<HEAT.size;gx++){
    const nx=-1+(gx+.5)*2/HEAT.size, ny=1-(gy+.5)*2/HEAT.size;if(nx*nx+ny*ny>1)continue;
    const v=HEAT.grid[gy*HEAT.size+gx];if(v<=0)continue;const a=Math.min(.92,.10+.80*Math.sqrt(v/HEAT.peak));
    ctx.fillStyle=`hsla(${Math.max(0,220-220*(v/HEAT.peak))}, 90%, 58%, ${a})`;ctx.fillRect(-r+gx*cell,-r+gy*cell,cell+1,cell+1);
  }
  ctx.strokeStyle='#dce8f5aa';ctx.lineWidth=1.2;
  ctx.beginPath();ctx.moveTo(-r,0);ctx.lineTo(r,0);ctx.moveTo(0,-r);ctx.lineTo(0,r);ctx.stroke();
  ctx.fillStyle='#b9c7d8';ctx.font='12px system-ui';ctx.fillText('LEFT',-r+24,0);ctx.fillText('RIGHT',r-24,0);ctx.fillText('UP',0,-r+15);ctx.fillText('DOWN',0,r-15);
  ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.strokeStyle='#dce8f5';ctx.stroke();ctx.beginPath();ctx.arc(0,0,4,0,Math.PI*2);ctx.fillStyle='#dce8f5';ctx.fill();ctx.restore();
}
resetHeatmap();
const SH={bins:new Map(),maxBins:80};
function sensBucket(v){return Math.round(v*20)/20}
function addSensTime(v,dt){const n=Number.isFinite(v)?v:1;const b=sensBucket(n);SH.bins.set(b,(SH.bins.get(b)||0)+Math.max(0,dt||0))}
function updateVelocityScale(){
  let peak=0;
  for(const d of vChart.data.datasets){
    for(const v of d.data){ if(Number.isFinite(v)) peak=Math.max(peak,Math.abs(v)); }
  }
  const target=Math.max(300,Math.ceil(peak/50)*50);
  const y=vChart.options.scales.y;
  if(y.min!==-target || y.max!==target){ y.min=-target; y.max=target; }
}
function charts(r,batched=false){if(S.frozen)return;const t=new Date(r.timestamp);const vals=[r.rawGyroX_deg_s,r.rawGyroY_deg_s,r.rawGyroZ_deg_s,r.processedGyroX_deg_s,r.processedGyroY_deg_s,r.processedGyroZ_deg_s];vChart.data.labels.push(t.toLocaleTimeString());vChart.data.datasets.forEach((d,i)=>d.data.push(vals[i]));aChart.data.labels.push(t.toLocaleTimeString());aChart.data.datasets[0].data.push(r.angularAcceleration_deg_s2);stChart.data.labels.push(t.toLocaleTimeString());stChart.data.datasets[0].data.push(Number.isFinite(r.effectiveSensitivity)?r.effectiveSensitivity:1);
  const cutoff=t.getTime()-CHART_WINDOW_MS;
  while(S.chartTimes?.length && S.chartTimes[0]<cutoff){S.chartTimes.shift();vChart.data.labels.shift();vChart.data.datasets.forEach(d=>d.data.shift());aChart.data.labels.shift();aChart.data.datasets[0].data.shift();stChart.data.labels.shift();stChart.data.datasets[0].data.shift();}
  if(!S.chartTimes)S.chartTimes=[]; S.chartTimes.push(t.getTime()); while(S.chartTimes.length>1 && S.chartTimes[0]<cutoff){S.chartTimes.shift();}
  updateSensitivityTimelineScale();
  if(!batched){vChart.update('none');aChart.update('none');stChart.update('none')}}
function featureArray(dv){return new Uint8Array(dv.buffer.slice(dv.byteOffset,dv.byteOffset+dv.byteLength))}
function i16(a,o){if(o<0||o+1>=a.length)return 0;const v=a[o]|(a[o+1]<<8);return v>0x7fff?v-0x10000:v}
function parseCalibration(input){
  const a=input instanceof DataView?featureArray(input):input; if(a.length<34)return null;
  const g={
    x:{bias:i16(a,0),plus:i16(a,6),minus:i16(a,8)},
    y:{bias:i16(a,2),plus:i16(a,10),minus:i16(a,12)},
    z:{bias:i16(a,4),plus:i16(a,14),minus:i16(a,16)}
  };
  const speedPlus=i16(a,18),speedMinus=i16(a,20),speed2x=speedPlus+speedMinus;
  for(const k of ['x','y','z']){g[k].denom=Math.abs(g[k].plus-g[k].bias)+Math.abs(g[k].minus-g[k].bias);g[k].numerator=speed2x*GYRO_RES}
  const acc={x:{plus:i16(a,22),minus:i16(a,24)},y:{plus:i16(a,26),minus:i16(a,28)},z:{plus:i16(a,30),minus:i16(a,32)}};
  for(const k of ['x','y','z']){acc[k].range=acc[k].plus-acc[k].minus;acc[k].bias=acc[k].plus-acc[k].range/2;acc[k].numerator=2*ACC_RES}
  return {bytes:a.length,raw:Array.from(a),gyro:g,accel:acc,speedPlus,speedMinus};
}
function factoryGyro(raw){if(!CAL.gyro)return {x:raw.x/GYRO_RES,y:raw.y/GYRO_RES,z:raw.z/GYRO_RES};const out={};for(const k of ['x','y','z']){const c=CAL.gyro[k];out[k]=(c.denom?((c.numerator*raw[k])/c.denom):raw[k])/GYRO_RES}return out}
function factoryAccel(raw){if(!CAL.accel)return {x:raw.x/ACC_RES,y:raw.y/ACC_RES,z:raw.z/ACC_RES};const out={};for(const k of ['x','y','z']){const c=CAL.accel[k];out[k]=c.range?((c.numerator*(raw[k]-c.bias))/c.range)/ACC_RES:raw[k]/ACC_RES}return out}
function renderCalibration(){if(!CAL.raw){$('initCalStatus').textContent='Not read';$('initCalStatus').className='value';return}$('initCalStatus').textContent=CAL.gyro&&CAL.accel?'OK':'Invalid';$('initCalStatus').className='value '+(CAL.gyro&&CAL.accel?'good':'bad');$('initCalLen').textContent=CAL.raw.length+' bytes';const gx=CAL.gyro?.x,gy=CAL.gyro?.y,gz=CAL.gyro?.z;$('calGyroX').textContent=gx&&gx.denom?(gx.numerator/gx.denom).toFixed(3)+'×':'—';$('calGyroY').textContent=gy&&gy.denom?(gy.numerator/gy.denom).toFixed(3)+'×':'—';$('calGyroZ').textContent=gz&&gz.denom?(gz.numerator/gz.denom).toFixed(3)+'×':'—';$('calAccelRange').textContent=CAL.accel?['x','y','z'].map(k=>CAL.accel[k].range).join(' / '):'—';$('calibrationBody').innerHTML=['x','y','z'].map(k=>{const g=CAL.gyro?.[k]||{},a=CAL.accel?.[k]||{};return `<tr><td>${k.toUpperCase()}</td><td>${g.bias??'—'}</td><td>${g.plus??'—'}</td><td>${g.minus??'—'}</td><td>${g.denom??'—'}</td><td>${a.plus??'—'}</td><td>${a.minus??'—'}</td><td>${a.bias??'—'}</td><td>${a.range??'—'}</td></tr>`}).join('')}
async function readFeature(id){if(!S.device)return null;try{const dv=await S.device.receiveFeatureReport(id);let a=featureArray(dv);const wire=Array.from(a);if(a.length&&a[0]===id&&a.length>=35)a=a.slice(1);CAL.featureReports.set(id,{length:a.length,payload:Array.from(a),reportIdPresent:wire.length!==a.length,wirePayload:wire});return a}catch(e){CAL.featureReports.set(id,{error:e.message});return null}}
async function initializeController(){
  if(!S.device)return false;
  const cal=await readFeature(0x05); CAL.raw=cal||null; const parsed=CAL.raw?parseCalibration(CAL.raw):null; CAL.gyro=parsed?.gyro||null; CAL.accel=parsed?.accel||null; renderCalibration();
  if(cal){$('initCalStatus').textContent=CAL.gyro&&CAL.accel?'OK':'Invalid';}
  const fw=await readFeature(0x20); CAL.firmware=fw||null; if(CAL.firmware&&CAL.firmware.length>=46){const a=CAL.firmware;const uv=a[44]|(a[45]<<8);$('initUpdateVersion').textContent='0x'+uv.toString(16).padStart(4,'0').toUpperCase();$('initFwStatus').textContent='OK'}else{$('initFwStatus').textContent=fw?'Read':'Unavailable'}
  return !!cal;
}
function jsmOffActive(reportBytes,linkOffset){
  if(!JSM.loaded||!JSM.gyroOffBindings.length||!reportBytes)return false;
  const a=reportBytes, o=linkOffset||0;
  const buttons=a[o+7]??0, buttons2=a[o+8]??0, buttons3=a[o+9]??0;
  const lx=(a[o+0]??128)-128, ly=(a[o+1]??128)-128, rx=(a[o+2]??128)-128, ry=(a[o+3]??128)-128;
  const triggerL=a[o+4]??0, triggerR=a[o+5]??0;
  const p=t=>{
    switch(t){
      case 'UP':return (buttons&0x10)!==0; case 'RIGHT':return (buttons&0x20)!==0; case 'DOWN':return (buttons&0x40)!==0; case 'LEFT':return (buttons&0x80)!==0;
      case 'W':return (buttons&0x01)!==0; case 'S':return (buttons&0x02)!==0; case 'E':return (buttons&0x04)!==0; case 'N':return (buttons&0x08)!==0;
      case 'L':case 'L1':case 'LB':return (buttons2&0x01)!==0; case 'R':case 'R1':case 'RB':return (buttons2&0x02)!==0;
      case 'ZL':case 'L2':case 'LT':return triggerL>30; case 'ZR':case 'R2':case 'RT':return triggerR>30;
      case 'L3':return (buttons2&0x04)!==0; case 'R3':return (buttons2&0x08)!==0;
      case 'CAPTURE':case 'TOUCHPAD':return (buttons3&0x02)!==0; case 'TOUCH':{const t0=a[o+32],t1=a[o+36]; if(t0===undefined||t1===undefined)return false; return ((t0&0x80)===0)||((t1&0x80)===0);} case '-':case 'SHARE':return (buttons2&0x10)!==0; case '+':case 'OPTIONS':return (buttons2&0x20)!==0; case 'HOME':case 'PS':return (buttons3&0x01)!==0;
      case 'LUP':return ly<-70; case 'LDOWN':return ly>70; case 'LLEFT':return lx<-70; case 'LRIGHT':return lx>70;
      case 'RUP':return ry<-70; case 'RDOWN':return ry>70; case 'RLEFT':return rx<-70; case 'RRIGHT':return rx>70;
      case 'LEFT_STICK':return Math.hypot(lx,ly)>70; case 'RIGHT_STICK':return Math.hypot(rx,ry)>70;
      case 'NONE':return false; default:return false;
    }
  };
  return JSM.gyroOffBindings.some(p);
}
function setGyroOff(active){if(S.gyroOff===active)return;S.gyroOff=active;$('gyroOffBadge').textContent=active?'GYRO OFF':'GYRO ON';$('gyroOffBadge').classList.toggle('active',active);}
function processIMU(rawCounts,accCounts,timestamp,gyroOff=false){
  if(!S.running)return;
  const now=timestamp??performance.now();
  if(S.lastT===null){S.lastT=now;S.prev={x:0,y:0,z:0}}
  const dt=Math.max(.001,Math.min(1,(now-S.lastT)/1000));
  S.lastT=now;S.lastDt=dt*1000;S.raw=factoryGyro(rawCounts);
  const c=cfg();
  let base={x:dz(S.raw.x-S.bias.x,c.deadzone),y:dz(S.raw.y-S.bias.y,c.deadzone),z:dz(S.raw.z-S.bias.z,c.deadzone)};
  setGyroOff(gyroOff);
  if(gyroOff){base={x:0,y:0,z:0};S.filter={x:0,y:0,z:0,init:false};}
  let p=base;
  if(c.filter){
    if(!S.filter.init){S.filter={x:p.x,y:p.y,z:p.z,init:true}}
    else{S.filter.x=c.alpha*p.x+(1-c.alpha)*S.filter.x;S.filter.y=c.alpha*p.y+(1-c.alpha)*S.filter.y;S.filter.z=c.alpha*p.z+(1-c.alpha)*S.filter.z}
    p={x:S.filter.x,y:S.filter.y,z:S.filter.z};
  }
  const inputSpeed=mag(p);
  const jsm=gyroOff?{x:0,y:0,z:0,sens:0,accelMult:1,sx:0,sy:0,cameraX:0,cameraY:0}:processJSM(p,inputSpeed);
  p={x:jsm.x,y:jsm.y,z:jsm.z};
  let velocity=mag(p);
  if(c.threshold&&velocity<c.velThreshold)p={x:0,y:0,z:0};
  if(gyroOff)p={x:0,y:0,z:0};
  const cameraX=gyroOff?0:(mag(p)>0?jsm.cameraX:0), cameraY=gyroOff?0:(mag(p)>0?jsm.cameraY:0);
  S.angularAcceleration=Math.hypot((p.x-S.prev.x)/dt,(p.y-S.prev.y)/dt,(p.z-S.prev.z)/dt);
  if(c.threshold&&S.angularAcceleration<c.accThreshold)S.angularAcceleration=0;
  if(gyroOff)S.angularAcceleration=0;
  S.prev={...p};S.processed={...p};
  const a=factoryAccel(accCounts),o=orientation(a);S.accel={...a};S.orientation={...o};
  S.peakVel=Math.max(S.peakVel,velocity);S.peakAcc=Math.max(S.peakAcc,S.angularAcceleration);S.samples++;
  addSensTime(gyroOff?0:jsm.sens,dt); if(!gyroOff){
    // Use the exact processed velocity that is written to CSV as the profile's canonical velocity.
    // Retain up to ~16.7 minutes at 1000 Hz so a normal Halo session is not replaced by only the final ~100 seconds.
    const profileVelocity=velocity;
    S.profileVel.push(profileVelocity); S.profileSensX.push(Number.isFinite(jsm.sx)?jsm.sx:1); S.profileSensY.push(Number.isFinite(jsm.sy)?jsm.sy:1); S.profileZones[profileZone(inputSpeed)]+=dt;
    const PROFILE_MAX_SAMPLES=1000000;
    if(S.profileVel.length>PROFILE_MAX_SAMPLES){const drop=S.profileVel.length-PROFILE_MAX_SAMPLES;S.profileVel.splice(0,drop);S.profileSensX.splice(0,drop);S.profileSensY.splice(0,drop);}
  }
  if(!gyroOff){addHeat(cameraX,cameraY,S.lastDt);if(performance.now()-HEAT.lastDraw>50){HEAT.lastDraw=performance.now();drawHeatmap();}} else if(HEAT.active.moving){commitHeatTurn();drawHeatmap();}
  const row={timestamp:new Date().toISOString(),rawGyroX_deg_s:S.raw.x,rawGyroY_deg_s:S.raw.y,rawGyroZ_deg_s:S.raw.z,processedGyroX_deg_s:p.x,processedGyroY_deg_s:p.y,processedGyroZ_deg_s:p.z,velocityMagnitude_deg_s:velocity,angularAcceleration_deg_s2:S.angularAcceleration,accelerometerX_g:a.x,accelerometerY_g:a.y,accelerometerZ_g:a.z,accelerometerMagnitude_g:mag(a),pitch_deg:o.pitch,roll_deg:o.roll,effectiveSensitivity:(Number.isFinite(jsm.sens)?jsm.sens:1),accelerationMultiplier:jsm.accelMult,gyroOff, cameraGyroX_deg_s:cameraX,cameraGyroY_deg_s:cameraY};
  addHistory({timestamp:row.timestamp,gx:p.x,gy:p.y,gz:p.z,vm:velocity,aa:S.angularAcceleration,ax:a.x,ay:a.y,az:a.z,pitch:o.pitch,roll:o.roll});
  csv(row);S.pendingChartRows.push(row);if(S.pendingChartRows.length>8)S.pendingChartRows.splice(0,S.pendingChartRows.length-8);scheduleUI(row);
}
function hidArray(r){return new Uint8Array(r.buffer.slice(r.byteOffset,r.byteOffset+r.byteLength))}
function signed16At(a,i){if(i<0||i+1>=a.length)return 0;const v=a[i]|(a[i+1]<<8);return v>0x7fff?v-0x10000:v}
function updateHidAnalyzer(id,r){
  const a=hidArray(r); HID.lastId=id; HID.lastLen=a.length; HID.count++; HID.rxCount++;
  const now=performance.now(); if(!HID.rateWindowStart)HID.rateWindowStart=now; if(now-HID.rateWindowStart>=1000){HID.rxHz=HID.rxCount;HID.rxCount=0;HID.rateWindowStart=now;$('hidHz').textContent=HID.rxHz+' Hz'}
  $('hidRid').textContent='0x'+id.toString(16).padStart(2,'0').toUpperCase();$('hidLen').textContent=a.length+' bytes';$('hidCount').textContent=HID.count;
  HID.ids.set(id,(HID.ids.get(id)||0)+1); if(HID.count<4||now-(HID.live.lastMeta||0)>250){HID.live.lastMeta=now;$('hidIds').textContent=[...HID.ids.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>'0x'+k.toString(16).padStart(2,'0').toUpperCase()+' ('+v+')').join(' · ')}
  if(id===0x31 && a.length>=77){if(!HID.crcTable){const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0}HID.crcTable=t}let crc=0xffffffff;for(const b of [0xA1,0x31])crc=(crc>>>8)^HID.crcTable[(crc^b)&255];for(let i=0;i<a.length-4;i++)crc=(crc>>>8)^HID.crcTable[(crc^a[i])&255];crc=(crc^0xffffffff)>>>0;const got=(a[a.length-4])|(a[a.length-3]<<8)|(a[a.length-2]<<16)|(a[a.length-1]<<24);$('hidCrc').textContent=crc===got?'OK':'BAD'}else $('hidCrc').textContent='—';
  let hex='';for(let i=0;i<a.length;i+=16){hex+=i.toString(16).padStart(2,'0').toUpperCase().padEnd(3,' ')+' '+Array.from(a.slice(i,i+16),v=>v.toString(16).padStart(2,'0')).join(' ')+'\n'}
  HID.live={...HID.live,id,bytes:a,hex:hex.trim(),dirty:true};
  if(!HID.capturing)return;
  let q=HID.byId.get(id);if(!q){q=[];HID.byId.set(id,q)}q.push(a);if(q.length>HID.maxReports)q.shift();
  if(now-HID.candidateTimer>500){HID.candidateTimer=now;renderHidCandidates(id)}
}
function candidateStats(samples,off){let sum=0,min=Infinity,max=-Infinity,d2=0,prev=0;for(let i=0;i<samples.length;i++){const v=signed16At(samples[i],off);sum+=v;if(v<min)min=v;if(v>max)max=v;if(i){const d=v-prev;d2+=d*d}prev=v}const n=samples.length;return {off,mean:sum/n,min,max,dr:Math.sqrt(d2/Math.max(1,n-1)),range:max-min,scaled:(sum/n)/1024}}
function renderHidCandidates(id){const samples=HID.byId.get(id)||[];if(samples.length<4)return;const rows=[];const len=Math.min(...samples.map(a=>a.length));for(let o=0;o<len-1;o++)rows.push(candidateStats(samples,o));rows.sort((a,b)=>b.dr-a.dr);const top=rows.slice(0,14);$('hidCandidates').innerHTML=top.map(c=>`<tr class="${c.dr>200?'candidate':''}"><td>${c.off}</td><td>${c.mean.toFixed(1)}</td><td>${c.min}</td><td>${c.max}</td><td>${c.dr.toFixed(1)}</td><td>${c.range}</td><td>${c.scaled.toFixed(3)}</td><td><button data-hid-gyro="${c.off}">Use as gyro</button> <button data-hid-accel="${c.off}">Use as accel</button></td></tr>`).join('');
  document.querySelectorAll('[data-hid-gyro]').forEach(b=>b.onclick=()=>{PARSER.gyroOffset=+b.dataset.hidGyro;updateParserInfo();banner('Testing gyro parser offset '+PARSER.gyroOffset+'. Rotate the controller and compare the live data.')});
  document.querySelectorAll('[data-hid-accel]').forEach(b=>b.onclick=()=>{PARSER.accelOffset=+b.dataset.hidAccel;updateParserInfo();banner('Testing accelerometer parser offset '+PARSER.accelOffset+'.')});
}
function updateParserInfo(){$('gyroOffsetInfo').textContent=PARSER.gyroOffset===null?'standard':String(PARSER.gyroOffset);$('accelOffsetInfo').textContent=PARSER.accelOffset===null?'standard':String(PARSER.accelOffset)}
$('hidCapture').onclick=()=>{HID.capturing=!HID.capturing;$('hidCapture').textContent=HID.capturing?'Stop analyzer capture':'Capture analyzer data';if(HID.capturing)banner('HID capture enabled. Live analyzer stays responsive; raw reports are retained in the background (up to 5000).');else banner('')};
$('hidDownload').onclick=()=>{const out=[];for(const [id,samples] of HID.byId.entries())for(const a of samples)out.push({reportId:'0x'+id.toString(16).padStart(2,'0').toUpperCase(),payload:Array.from(a)});if(!out.length){banner('No analyzer samples captured. Start capture first.');return}const blob=new Blob([JSON.stringify({created:new Date().toISOString(),controller:S.device?{vendorId:S.device.vendorId,productId:S.device.productId,productName:S.device.productName}:null,initialization:{featureReports:Object.fromEntries(CAL.featureReports),calibration:CAL.raw?{payload:Array.from(CAL.raw),parsed:{gyro:CAL.gyro,accel:CAL.accel}}:null,firmware:CAL.firmware?Array.from(CAL.firmware):null},reports:out},null,2)],{type:'application/json'});const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='dualsense-hid-capture-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();URL.revokeObjectURL(u)};
$('hidClear').onclick=()=>{HID.count=0;HID.byId.clear();HID.ids.clear();HID.rxCount=0;HID.rxHz=0;HID.rateWindowStart=performance.now();HID.live={id:0,bytes:null,hex:'',dirty:false};$('hidCount').textContent='0';$('hidIds').textContent='—';$('hidCrc').textContent='—';$('hidCandidates').innerHTML='<tr><td colspan="8" style="text-align:left">Move the controller after starting analyzer capture.</td></tr>';$('hidHex').textContent='Analyzer cleared.'};
$('hidResetParser').onclick=()=>{PARSER.gyroOffset=null;PARSER.accelOffset=null;updateParserInfo();banner('Parser offsets reset to the standard DualSense layout.')};
function parseReport(event){const now=performance.now();S.rxCount++;if(!S.rateWindowStart)S.rateWindowStart=now;if(now-S.rateWindowStart>=1000){S.rxHz=S.rxCount;S.rxCount=0;S.rateWindowStart=now;$('rate').textContent=S.rxHz+' Hz'}const id=event.reportId,r=event.data;updateHidAnalyzer(id,r);if(id===0x31){S.link='bluetooth';const a=hidArray(r);parseFull(r,1,jsmOffActive(a,1))}else if(id===0x01&&r.byteLength>=USB_LEN){S.link='usb';const a=hidArray(r);parseFull(r,0,jsmOffActive(a,0))}}
function parseFull(r,o,gyroOff=false){const go=PARSER.gyroOffset===null?o+15:PARSER.gyroOffset;const ao=PARSER.accelOffset===null?o+21:PARSER.accelOffset;if(go+5>=r.byteLength||ao+5>=r.byteLength)return;const gyro={x:signed16At(new Uint8Array(r.buffer,r.byteOffset,r.byteLength),go),y:signed16At(new Uint8Array(r.buffer,r.byteOffset,r.byteLength),go+2),z:signed16At(new Uint8Array(r.buffer,r.byteOffset,r.byteLength),go+4)};const acc={x:signed16At(new Uint8Array(r.buffer,r.byteOffset,r.byteLength),ao),y:signed16At(new Uint8Array(r.buffer,r.byteOffset,r.byteLength),ao+2),z:signed16At(new Uint8Array(r.buffer,r.byteOffset,r.byteLength),ao+4)};processIMU(gyro,acc,performance.now(),gyroOff)}
async function connect(){if(!('hid' in navigator)){banner('WebHID is not available in this browser. Use a Chromium browser with WebHID support and serve this app from localhost or HTTPS.');showStatus('WebHID unavailable',false,true);return}try{const devices=await navigator.hid.requestDevice({filters:[{vendorId:SONY,productId:DS},{vendorId:SONY,productId:EDGE}]});if(!devices.length)return;await open(devices[0])}catch(e){banner('Connection failed: '+e.message);showStatus('Connection failed',false,true)}}
async function open(d){S.device=d;if(!d.opened)await d.open();S.link=detectLink(d);d.oninputreport=parseReport;$('model').textContent=d.productName||((d.productId===EDGE)?'DualSense Edge':'DualSense');$('vidpid').textContent='054C:'+d.productId.toString(16).padStart(4,'0').toUpperCase();$('transport').textContent=S.link.toUpperCase();showStatus('Initializing · '+S.link.toUpperCase(),true);banner('Reading DualSense factory calibration (feature 0x05) and firmware info (0x20)…');await initializeController();S.running=true;S.lastT=null;showStatus('Connected · '+S.link.toUpperCase(),true);banner(CAL.gyro&&CAL.accel?'Factory calibration loaded. IMU values are now normalized using the controller calibration.':'Factory calibration could not be read; using standard sensor scaling.')}function detectLink(d){for(const c of d.collections||[]){if(c.usagePage===1&&c.usage===5){const bits=c.inputReports?.reduce((m,r)=>Math.max(m,r.items.reduce((s,i)=>s+i.reportSize*i.reportCount,0)),0)||0;if(bits===616)return'bluetooth';if(bits===504)return'usb'}}return'unknown'}
async function disconnect(){if(S.device){try{S.device.oninputreport=null;await S.device.close()}catch(e){} }S.device=null;S.running=false;setGyroOff(false);showStatus('Not connected');$('model').textContent='—';$('transport').textContent='—'}
navigator.hid?.addEventListener('disconnect',e=>{if(e.device===S.device)disconnect()});
$('refreshInit').onclick=async()=>{if(!S.device){banner('Connect the controller first.');return}banner('Refreshing DualSense initialization reports…');await initializeController();banner(CAL.gyro&&CAL.accel?'Factory calibration refreshed.':'Calibration read failed; standard scaling remains active.')};$('connect').onclick=connect;$('disconnect').onclick=disconnect;$('calibrate').onclick=()=>{if(!S.running){banner('Connect the controller first.');return}S.bias={...S.raw};S.filter={x:0,y:0,z:0,init:false};S.prev={x:0,y:0,z:0};S.calibrated=true;showStatus('Gyro calibrated',true)};$('freeze').onclick=()=>{S.frozen=!S.frozen;$('freeze').textContent=S.frozen?'Unfreeze display':'Freeze display'};$('record').onclick=()=>{if(!S.recording){S.recording=true;S.csv=[];S.csvRows=0;$('record').textContent='Stop & download CSV';$('record').classList.add('danger')}else{S.recording=false;download();$('record').textContent='Start CSV recording';$('record').classList.remove('danger')}renderLive()};$('clear').onclick=()=>{S.history=[];S.samples=0;S.peakVel=0;S.profileVel=[];S.profileSensX=[];S.profileSensY=[];S.profileZones={low:0,ramp:0,max:0};S.peakAcc=0;S.csv=[];S.csvRows=0;S.chartTimes=[];vChart.data.labels=[];vChart.data.datasets.forEach(d=>d.data=[]);aChart.data.labels=[];aChart.data.datasets[0].data=[];vChart.update('none');aChart.update('none');$('historyBody').innerHTML='';SH.bins.clear();resetHeatmap();sChart.data.labels=[];sChart.data.datasets[0].data=[];stChart.data.labels=[];stChart.data.datasets[0].data=[];updateSensitivityTimelineScale();sChart.update('none');stChart.update('none');S.pendingChartRows.length=0;updateAimingProfile();renderLive({x:0,y:0,z:0},{x:0,y:0,z:0},{pitch:0,roll:0})};
S.processed={x:0,y:0,z:0};S.accel={x:0,y:0,z:0};S.orientation={pitch:0,roll:0};renderLive();

$('saveRun').onclick=saveCurrentRun; renderRuns();
