
function enterBensWorld(){
  var door=document.getElementById('birthdayDoor');
  if(!door) return;
  door.style.transition='opacity .55s ease';
  door.style.opacity='0';
  door.style.pointerEvents='none';
  setTimeout(function(){door.remove();},580);
  setTimeout(function(){
    try{ window.dispatchEvent(new Event('resize')); }catch(e){}
  },650);
}

const PHOTO_BUCKET='family-photos';
const FAMILY_STATE_TABLE='family_app_state';
const COUNTRY_KEY='bensWorldCountryRegistry';
const TRIP_KEY='bensWorldAddedTripsV2';
const OVERRIDE_KEY='bensWorldBaseOverridesV1';
const DELETED_PHOTO_KEY='bensWorldDeletedPhotoPathsV1';
const SIGNED_URL_TTL=60*60;
const cloudDeviceId=crypto.randomUUID();
let supabaseClient=null;
let familyUser=null;
let cloudReady=false;
let cloudAssetMappings={};
let deletedPhotoPaths=new Set();
let cloudSyncTimer=null;
let cloudSyncQueue=Promise.resolve();
let cloudBootedUserId='';
let cloudStartingUserId='';
let cloudRefreshTimer=null;
const signedPhotoPaths=new Map();
const signedPhotoUrls=new Map();
let cloudChannel=null;

function setCloudStatus(message,isError=false){
  const element=document.getElementById('cloudStatusText');
  if(element){element.textContent=message;element.style.color=isError?'#ff9d9d':'';}
}

function setAuthMessage(message,isError=false){
  const element=document.getElementById('authMessage');
  if(element){element.textContent=message;element.style.color=isError?'#ff9d9d':'';}
}

function storageReference(path){return `supabase-storage:${path}`}

function photoStoragePath(value){
  if(typeof value!=='string')return '';
  if(value.startsWith('supabase-storage:'))return value.slice('supabase-storage:'.length);
  const knownPath=signedPhotoPaths.get(value)||cloudAssetMappings[value];
  if(knownPath)return knownPath;
  try{
    const url=new URL(value);
    const match=url.pathname.match(/\/storage\/v1\/object\/(?:sign|public)\/family-photos\/(.+)$/);
    return match?decodeURIComponent(match[1]):'';
  }catch{
    return '';
  }
}

function withoutDeletedPhotoReferences(value,copies=new WeakMap()){
  if(typeof value==='string')return deletedPhotoPaths.has(photoStoragePath(value))?undefined:value;
  if(!value||typeof value!=='object')return value;
  if(copies.has(value))return copies.get(value);
  if(!Array.isArray(value)&&(typeof value.src==='string'||typeof value.data==='string')
    &&[value.src,value.data].some(reference=>deletedPhotoPaths.has(photoStoragePath(reference))))return undefined;
  const copy=Array.isArray(value)?[]:{};
  copies.set(value,copy);
  if(Array.isArray(value)){
    value.forEach(item=>{
      const cleaned=withoutDeletedPhotoReferences(item,copies);
      if(cleaned!==undefined)copy.push(cleaned);
    });
  }else{
    Object.entries(value).forEach(([key,item])=>{
      const path=typeof item==='string'?photoStoragePath(item):'';
      if(key==='defaultPhoto'&&deletedPhotoPaths.has(path))return;
      const cleaned=withoutDeletedPhotoReferences(item,copies);
      if(cleaned!==undefined)copy[key]=cleaned;
    });
  }
  return copy;
}

function mapNestedValues(value,mapLeaf){
  const copies=new WeakMap();
  const visit=item=>{
    const mapped=mapLeaf(item);
    if(mapped!==item)return mapped;
    if(!item||typeof item!=='object')return item;
    if(copies.has(item))return copies.get(item);
    const copy=Array.isArray(item)?[]:{};
    copies.set(item,copy);
    if(Array.isArray(item))item.forEach(child=>copy.push(visit(child)));
    else Object.entries(item).forEach(([key,child])=>{copy[key]=visit(child)});
    return copy;
  };
  return visit(value);
}

function localStateSnapshot(){
  const parse=(key,fallback)=>{const raw=localStorage.getItem(key);return raw===null?fallback:JSON.parse(raw)};
  return {
    countries:parse(COUNTRY_KEY,loadCountryRegistry()),
    trips:parse(TRIP_KEY,[]),
    overrides:parse(OVERRIDE_KEY,{}),
    assetMappings:cloudAssetMappings,
    deletedPhotoPaths:[...deletedPhotoPaths]
  };
}

function writeLocalState(state){
  localStorage.setItem(COUNTRY_KEY,JSON.stringify(state.countries||[]));
  localStorage.setItem(TRIP_KEY,JSON.stringify(state.trips||[]));
  localStorage.setItem(OVERRIDE_KEY,JSON.stringify(state.overrides||{}));
  localStorage.setItem(DELETED_PHOTO_KEY,JSON.stringify(state.deletedPhotoPaths||[]));
  cloudAssetMappings=state.assetMappings||{};
  deletedPhotoPaths=new Set(state.deletedPhotoPaths||[]);
}

async function createWebp(blob){
  let source=blob;
  if(/image\/hei[cf]/i.test(blob.type)||/\.hei[cf]$/i.test(blob.name||'')){
    if(typeof window.heic2any!=='function')throw new Error('HEIC support could not load. Check your internet connection and try again.');
    const converted=await window.heic2any({blob,toType:'image/jpeg',quality:.92});
    source=Array.isArray(converted)?converted[0]:converted;
  }
  let bitmap;
  try{bitmap=await createImageBitmap(source,{imageOrientation:'from-image'});}
  catch{throw new Error('This image could not be decoded. Try exporting it as JPEG or WebP and upload it again.');}
  const scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));
  canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const context=canvas.getContext('2d');
  if(!context){bitmap.close();throw new Error('This browser could not prepare the image for upload.');}
  context.drawImage(bitmap,0,0,canvas.width,canvas.height);
  bitmap.close();
  const webp=await new Promise((resolve,reject)=>{
    canvas.toBlob(result=>result?resolve(result):reject(new Error('WebP conversion failed in this browser.')),'image/webp',.8);
  });
  if(webp.type!=='image/webp')throw new Error('This browser cannot create WebP images. Try a current version of Chrome, Edge, Firefox, or Safari.');
  return webp;
}

async function readPhotoMetadata(blob){
  if(!window.exifr?.parse)return {};
  try{
    const result=await window.exifr.parse(blob,{gps:true});
    if(!result)return {};
    const captured=result.DateTimeOriginal||result.CreateDate||result.ModifyDate||null;
    const date=captured instanceof Date&&!Number.isNaN(captured.getTime())
      ?`${captured.getFullYear()}-${String(captured.getMonth()+1).padStart(2,'0')}-${String(captured.getDate()).padStart(2,'0')} ${String(captured.getHours()).padStart(2,'0')}:${String(captured.getMinutes()).padStart(2,'0')}:${String(captured.getSeconds()).padStart(2,'0')}`
      :captured?String(captured):'';
    const latitude=Number(result.latitude),longitude=Number(result.longitude);
    const gps=Number.isFinite(latitude)&&Number.isFinite(longitude)&&Math.abs(latitude)<=90&&Math.abs(longitude)<=180
      ?[latitude,longitude]:null;
    return {date,gps};
  }catch(error){
    console.warn('Photo EXIF metadata could not be read; the image will still be uploaded.',error);
    return {};
  }
}

let photoGpsResolver=null;

function requestPhotoGps(filename){
  if(photoGpsResolver)throw new Error('Finish entering coordinates for the current photo first.');
  const dialog=document.getElementById('photoGpsBack');
  const latitude=document.getElementById('photoGpsLatitude');
  const longitude=document.getElementById('photoGpsLongitude');
  document.getElementById('photoGpsPrompt').textContent=`No GPS coordinates were found for ${filename}. Add its location, or skip to continue without coordinates.`;
  document.getElementById('photoGpsMessage').textContent='';
  latitude.value='';
  longitude.value='';
  dialog.style.display='flex';
  setTimeout(()=>latitude.focus(),0);
  return new Promise(resolve=>{photoGpsResolver=resolve});
}

function finishPhotoGps(gps){
  if(!photoGpsResolver)return;
  const resolve=photoGpsResolver;
  photoGpsResolver=null;
  document.getElementById('photoGpsBack').style.display='none';
  resolve(gps);
}

function submitPhotoGps(event){
  event.preventDefault();
  const message=document.getElementById('photoGpsMessage');
  const latitudeText=document.getElementById('photoGpsLatitude').value.trim();
  const longitudeText=document.getElementById('photoGpsLongitude').value.trim();
  const latitude=Number(latitudeText),longitude=Number(longitudeText);
  if(!latitudeText||!longitudeText||!Number.isFinite(latitude)||!Number.isFinite(longitude)
    ||Math.abs(latitude)>90||Math.abs(longitude)>180){
    message.textContent='Enter a valid latitude from −90 to 90 and longitude from −180 to 180.';
    return;
  }
  finishPhotoGps([latitude,longitude]);
}

function skipPhotoGps(){finishPhotoGps(null)}

async function uploadWebp(blob,filename){
  if(!familyUser)throw new Error('Sign in before uploading photos.');
  const path=`${familyUser.id}/${crypto.randomUUID()}.webp`;
  const {error:uploadError}=await supabaseClient.storage.from(PHOTO_BUCKET).upload(path,blob,{
    contentType:'image/webp',cacheControl:'3600',upsert:false
  });
  if(uploadError)throw new Error(`Photo upload failed: ${uploadError.message}`);
  const {data,error:signedError}=await supabaseClient.storage.from(PHOTO_BUCKET).createSignedUrl(path,SIGNED_URL_TTL);
  if(signedError){
    const {error:cleanupError}=await supabaseClient.storage.from(PHOTO_BUCKET).remove([path]);
    if(cleanupError)throw new Error(`Could not prepare the uploaded photo for display (${signedError.message}); cleanup also failed (${cleanupError.message}).`);
    throw new Error(`Could not prepare the uploaded photo for display: ${signedError.message}`);
  }
  signedPhotoPaths.set(data.signedUrl,path);
  signedPhotoUrls.set(path,data.signedUrl);
  return {path,url:data.signedUrl,name:filename};
}

async function processAndUploadPhoto(file){
  const metadata=await readPhotoMetadata(file);
  const gps=metadata.gps||await requestPhotoGps(file.name);
  const webp=await createWebp(file);
  const uploaded=await uploadWebp(webp,file.name);
  return {name:file.name,data:uploaded.url,storagePath:uploaded.path,date:metadata.date||'',gps};
}

async function uploadDataUrl(dataUrl){
  const response=await fetch(dataUrl);
  if(!response.ok)throw new Error('A previously saved browser photo could not be read for cloud migration.');
  const blob=await response.blob();
  const webp=await createWebp(blob);
  const uploaded=await uploadWebp(webp,'Previously uploaded photo');
  return storageReference(uploaded.path);
}

async function cloudify(value){
  if(typeof value==='string'){
    if(value.startsWith('data:image/'))return uploadDataUrl(value);
    const path=signedPhotoPaths.get(value);
    if(path)return storageReference(path);
    return value;
  }
  if(Array.isArray(value))return Promise.all(value.map(cloudify));
  if(value&&typeof value==='object'){
    const entries=await Promise.all(Object.entries(value).map(async([key,item])=>[key,await cloudify(item)]));
    return Object.fromEntries(entries);
  }
  return value;
}

async function signPhotoPaths(paths){
  const unique=[...new Set(paths)];
  for(let index=0;index<unique.length;index+=100){
    const batch=unique.slice(index,index+100);
    const {data,error}=await supabaseClient.storage.from(PHOTO_BUCKET).createSignedUrls(batch,SIGNED_URL_TTL);
    if(error)throw new Error(`Could not load stored photos: ${error.message}`);
    for(const entry of data||[]){
      if(entry.error)throw new Error(`Could not load a stored photo: ${entry.error}`);
      if(entry.path&&entry.signedUrl){
        signedPhotoUrls.set(entry.path,entry.signedUrl);
        signedPhotoPaths.set(entry.signedUrl,entry.path);
      }
    }
  }
}

async function hydrateCloudState(state){
  const clean=withoutDeletedPhotoReferences(state);
  const hydrated=mapNestedValues(clean,value=>{
    if(typeof value==='string'&&cloudAssetMappings[value])return storageReference(cloudAssetMappings[value]);
    return value;
  });
  const paths=new Set();
  const seen=new WeakSet();
  const collect=value=>{
    if(typeof value==='string'&&value.startsWith('supabase-storage:'))paths.add(value.slice('supabase-storage:'.length));
    else if(value&&typeof value==='object'&&!seen.has(value)){
      seen.add(value);
      Object.values(value).forEach(collect);
    }
  };
  collect(hydrated);
  await signPhotoPaths([...paths]);
  return mapNestedValues(hydrated,value=>{
    if(typeof value==='string'&&value.startsWith('supabase-storage:'))return signedPhotoUrls.get(value.slice('supabase-storage:'.length))||value;
    return value;
  });
}

async function readCloudState(){
  const {data,error}=await supabaseClient.from(FAMILY_STATE_TABLE).select('state,updated_by').eq('id','shared').maybeSingle();
  if(error)throw new Error(`Could not load the family album: ${error.message}`);
  return data;
}

async function persistCloudState(){
  if(!cloudReady||!familyUser)return;
  const local=localStateSnapshot();
  const cloudState=await cloudify(local);
  const {error}=await supabaseClient.from(FAMILY_STATE_TABLE).upsert({
    id:'shared',state:cloudState,updated_by:familyUser.id,updated_from:cloudDeviceId,updated_at:new Date().toISOString()
  },{onConflict:'id'});
  if(error)throw new Error(`Could not sync changes to Supabase: ${error.message}`);
  writeLocalState(await hydrateCloudState(cloudState));
  setCloudStatus('All changes synced');
}

function queueCloudSave(){
  if(!cloudReady)return;
  setCloudStatus('Syncing changes…');
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer=setTimeout(()=>flushCloudState().catch(error=>setCloudStatus(error.message,true)),500);
}

function flushCloudState(){
  clearTimeout(cloudSyncTimer);
  cloudSyncQueue=cloudSyncQueue.catch(()=>{}).then(persistCloudState);
  return cloudSyncQueue;
}

async function applyCloudSnapshot(state){
  deletedPhotoPaths=new Set(state.deletedPhotoPaths||[]);
  cloudAssetMappings=state.assetMappings||{};
  const clean=withoutDeletedPhotoReferences({
    countries:state.countries||loadCountryRegistry(),
    trips:state.trips||[],
    overrides:state.overrides||{},
    assetMappings:state.assetMappings||{},
    deletedPhotoPaths:[...deletedPhotoPaths]
  });
  cloudAssetMappings=clean.assetMappings||{};
  const hydrated=await hydrateCloudState(clean);
  writeLocalState(hydrated);
}

async function refreshBundledPhotoUrls(){
  const toStorageReference=value=>{
    if(typeof value==='string'){
      const path=cloudAssetMappings[value]||signedPhotoPaths.get(value);
      return path?storageReference(path):value;
    }
    return value;
  };
  ALL=withoutDeletedPhotoReferences(await hydrateCloudState(mapNestedValues(ALL,toStorageReference)));
  const refreshed=withoutDeletedPhotoReferences(await hydrateCloudState(mapNestedValues(BASE_ALL,toStorageReference)));
  BASE_ALL.splice(0,BASE_ALL.length,...refreshed);
}

function setSignedInView(signedIn){
  document.body.classList.toggle('auth-required',!signedIn);
  document.getElementById('authGate').setAttribute('aria-hidden',String(signedIn));
}

async function startFamilySession(user){
  if(cloudBootedUserId===user.id||cloudStartingUserId===user.id)return;
  cloudStartingUserId=user.id;
  familyUser=user;
  cloudReady=false;
  signedPhotoPaths.clear();
  signedPhotoUrls.clear();
  setAuthMessage('');
  setCloudStatus('Loading family album…');
  try{
    const row=await readCloudState();
    if(row?.state){
      await applyCloudSnapshot(row.state);
    }else{
      const initial=localStateSnapshot();
      await applyCloudSnapshot(initial);
      cloudReady=true;
      await persistCloudState();
    }
    await refreshBundledPhotoUrls();
    cloudReady=true;
    cloudBootedUserId=user.id;
    cloudStartingUserId='';
    setSignedInView(true);
    renderAddedTrips();
    rebuildMaster();
    setCloudStatus('Family album synced');
    document.getElementById('migratePhotosButton').hidden=[...bundledPhotoPaths()].every(path=>cloudAssetMappings[path]);
    cloudChannel=supabaseClient.channel('family-album-state').on('postgres_changes',{
      event:'UPDATE',schema:'public',table:FAMILY_STATE_TABLE,filter:'id=eq.shared'
    },async payload=>{
      if(payload.new?.updated_from===cloudDeviceId)return;
      try{
        await applyCloudSnapshot(payload.new.state);
        await refreshBundledPhotoUrls();
        rebuildMaster();
        setCloudStatus('Updated from another device');
      }catch(error){setCloudStatus(error.message,true);}
    }).subscribe();
    clearInterval(cloudRefreshTimer);
    cloudRefreshTimer=setInterval(async()=>{
      try{
        await flushCloudState();
        const latest=await readCloudState();
        if(latest?.state){await applyCloudSnapshot(latest.state);await refreshBundledPhotoUrls();rebuildMaster();}
      }catch(error){setCloudStatus(error.message,true);}
    },50*60*1000);
  }catch(error){
    cloudReady=false;
    cloudStartingUserId='';
    setAuthMessage(error.message,true);
    setCloudStatus('Cloud connection failed',true);
  }
}

async function signOutFamily(){
  const {error}=await supabaseClient.auth.signOut();
  if(error){setCloudStatus(`Sign out failed: ${error.message}`,true);return;}
  familyUser=null;
  cloudReady=false;
  cloudBootedUserId='';
  clearInterval(cloudRefreshTimer);
  if(cloudChannel){await supabaseClient.removeChannel(cloudChannel);cloudChannel=null;}
  setSignedInView(false);
  setCloudStatus('Signed out');
}

function bundledPhotoPaths(){
  const paths=new Set();
  const seen=new WeakSet();
  const pending=[...ALL,...BASE_ALL];
  while(pending.length){
    const value=pending.pop();
    if(typeof value==='string'){
      if(/^assets\/images\/.*\.(?:jpe?g|webp)$/i.test(value))paths.add(value);
    }else if(value&&typeof value==='object'&&!seen.has(value)){
      seen.add(value);
      pending.push(...Object.values(value));
    }
  }
  return paths;
}

async function migrateBundledPhotos(){
  const button=document.getElementById('migratePhotosButton');
  button.disabled=true;
  const paths=bundledPhotoPaths();
  const completed={...cloudAssetMappings};
  const pending=[...paths].filter(path=>!completed[path]);
  try{
    for(let index=0;index<pending.length;index++){
      const assetPath=pending[index];
      setCloudStatus(`Moving built-in photos ${index+1} of ${pending.length}…`);
      const response=await fetch(assetPath);
      if(!response.ok)throw new Error(`Could not read built-in photo ${assetPath} (${response.status}).`);
      const webp=await createWebp(await response.blob());
      const path=`${familyUser.id}/built-in/${assetPath.split('/').pop().replace(/\.[^.]+$/,'')}.webp`;
      const {error}=await supabaseClient.storage.from(PHOTO_BUCKET).upload(path,webp,{
        contentType:'image/webp',cacheControl:'3600',upsert:true
      });
      if(error)throw new Error(`Could not move ${assetPath}: ${error.message}`);
      completed[assetPath]=path;
    }
    cloudAssetMappings=completed;
    await flushCloudState();
    await refreshBundledPhotoUrls();
    rebuildMaster();
    button.hidden=true;
    setCloudStatus(`Moved ${pending.length} built-in photos to private storage`);
  }catch(error){
    cloudAssetMappings=completed;
    setCloudStatus(error.message,true);
    button.disabled=false;
  }
}

async function initializeFamilyCloud(){
  const config=window.BENS_WORLD_SUPABASE;
  if(!config?.url||!config?.publishableKey||!window.supabase?.createClient){
    setAuthMessage('Cloud sign-in could not load. Check the connection and Supabase configuration.',true);
    setCloudStatus('Cloud setup is incomplete',true);
    return;
  }
  supabaseClient=window.supabase.createClient(config.url,config.publishableKey);
  document.getElementById('authForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const submit=document.getElementById('authSubmit');
    submit.disabled=true;
    setAuthMessage('Signing in…');
    const {data,error}=await supabaseClient.auth.signInWithPassword({
      email:document.getElementById('authEmail').value.trim(),
      password:document.getElementById('authPassword').value
    });
    submit.disabled=false;
    if(error){setAuthMessage(error.message,true);return;}
    if(data.user)await startFamilySession(data.user);
  });
  supabaseClient.auth.onAuthStateChange((event,session)=>{
    if(event==='SIGNED_OUT'){
      familyUser=null;cloudReady=false;cloudBootedUserId='';
      setSignedInView(false);
      if(cloudChannel){supabaseClient.removeChannel(cloudChannel);cloudChannel=null;}
    }else if(session?.user){
      queueMicrotask(()=>startFamilySession(session.user));
    }
  });
  const {data,error}=await supabaseClient.auth.getSession();
  if(error){setAuthMessage(`Could not restore sign-in: ${error.message}`,true);return;}
  if(data.session?.user)await startFamilySession(data.session.user);
  else setCloudStatus('Sign in to open the family album');
}

;

let ALL=[{"name":"Brussels","country":"Belgium","lat":50.8467,"lng":4.3525,"year":2006,"date":"Aug 17, 2006","note":"Grand-Place / Grote Markt","photo":"assets/images/dd96716807593a9136bd27e4046a115270bd3f7d3670c2db0ef20da08b89ec49.jpg"},{"name":"Lisbon","country":"Portugal","lat":38.7223,"lng":-9.1393,"year":2023,"date":"2023 — exact date being reconciled","note":"Lisbon — Ben’s 2023 visit","photo":"assets/images/c2d7d3ad5d2753d6f3e3a1c7f426e3a9fab856c486ffad4a296b9fdeb0f6730b.jpg"},{"name":"Ljubljana","country":"Slovenia","lat":46.0569,"lng":14.5058,"year":2016,"date":"Jul 19, 2016","note":"2016 Europe trip","photo":""},{"name":"Dolomites","country":"Italy","lat":46.54,"lng":11.85,"year":2016,"date":"Jul 22–26, 2016","note":"Hiking and alpine villages","photo":"assets/images/b9cfec6249676bd79b9b294f9aeab028b1dba711191a79a4d51ae82cb248d493.jpg"},{"name":"Innsbruck","country":"Austria","lat":47.2692,"lng":11.4041,"year":2016,"date":"Jul 27, 2016","note":"Golden Roof / old town","photo":"assets/images/dae28605e923bd67c9fe7e12d7f9ea57eb545d0bab316aade7b1d27c922c895d.jpg"},{"name":"Sydney","country":"Australia","lat":-33.8688,"lng":151.2093,"year":2019,"date":"2019","note":"Sydney / Luna Park","photo":"assets/images/52e35227008a9ab6668c5f933986f066b1ce16ff43d80ec69a56d12a6d87ca34.jpg"},{"name":"Sarajevo","country":"Bosnia & Herzegovina","lat":43.8563,"lng":18.4131,"year":2021,"date":"2021","note":"Vijećnica / Sarajevo","photo":""},{"name":"Mostar","country":"Bosnia & Herzegovina","lat":43.3438,"lng":17.8078,"year":2021,"date":"2021","note":"Stari Most","photo":""},{"name":"Dubrovnik","country":"Croatia","lat":42.6507,"lng":18.0944,"year":2021,"date":"2021","note":"Old City","photo":""},{"name":"Zagreb","country":"Croatia","lat":45.815,"lng":15.9819,"year":2021,"date":"2021","note":"St. Mark’s Church","photo":""},{"name":"Sveti Stefan","country":"Montenegro","lat":42.2559,"lng":18.8962,"year":2021,"date":"2021","note":"Adriatic coast","photo":""},{"name":"Albania","country":"Albania","lat":41.3275,"lng":19.8187,"year":2021,"date":"2021","note":"Country confirmed; city still being refined","photo":""},{"name":"Paris","country":"France","lat":48.8566,"lng":2.3522,"year":2023,"date":"Feb 2023","note":"Paris / Eiffel Tower / Place Vendôme","photo":"assets/images/b51b8c5eea792e39cd02c0da532b0cc7cbe567ed92432a5fccb8575ce4949e8a.jpg"},{"name":"Copenhagen","country":"Denmark","lat":55.6761,"lng":12.5683,"year":2023,"date":"2023","note":"Copenhagen","photo":"assets/images/b9b54b407b9aca0b4902ba64eaa48eda09071d3a862814ee1ba9cd3b787182f0.jpg"},{"name":"Prague","country":"Czech Republic","lat":50.0755,"lng":14.4378,"year":2023,"date":"2023","note":"Old Town Square / historic center","photo":"assets/images/efa6b7aeb4f8a1c8784a586a16c1584d9375463a4cd1cba55ec1970593d3b7c0.jpg"},{"name":"Southern Thailand","country":"Thailand","lat":8.905,"lng":98.601,"year":2023,"date":"Apr 2023","note":"GPS-supported southern Thailand cluster","photo":"","photoAudit":{"status":"ben-evidence","files":["PXL_20230417_073726071.MP.jpg","PXL_20230417_081719504.jpg"],"pendingImageIntegration":true}},{"name":"Cambodia / Angkor","country":"Cambodia","lat":13.4125,"lng":103.867,"year":2023,"date":"2023","note":"Angkor-area temple photographs","photo":"assets/images/80036a045364a8bc9a3663d11d03b1e0c53e8af483a12f1c1250600c64657b9d.jpg"},{"name":"Luang Prabang","country":"Laos","lat":19.884,"lng":102.135,"year":2023,"date":"2023","note":"Luang Prabang / temple / waterfall","photo":"assets/images/47e050b271e7fc4a627eed6e163dafd027f1164e12e456728f157ad58789eac6.jpg"},{"name":"Ho Chi Minh City","country":"Vietnam","lat":10.7706,"lng":106.6963,"year":2023,"date":"Jul 14, 2023","note":"Vietnam","photo":""},{"name":"Hoi An","country":"Vietnam","lat":15.8768,"lng":108.3732,"year":2023,"date":"Jul 19, 2023","note":"Vietnam","photo":""},{"name":"Da Nang","country":"Vietnam","lat":16.0532,"lng":108.2025,"year":2023,"date":"Jul 21, 2023","note":"Vietnam","photo":""},{"name":"Ha Long Bay","country":"Vietnam","lat":20.84,"lng":107.05,"year":2023,"date":"Jul 22, 2023","note":"Vietnam","photo":"assets/images/2a6dcdb93569bf40564f220fa17f3b59b880afacc2f228c407cd6dbcf28d2ee7.jpg","photos":[{"src":"assets/images/2a6dcdb93569bf40564f220fa17f3b59b880afacc2f228c407cd6dbcf28d2ee7.jpg","date":"Jul 22, 2023","gps":[20.8690083,106.9985306],"ben":true,"source":"GPS + Ben identified in metadata","filename":"PXL_20230722_034847207.jpg"},{"src":"assets/images/1959e7a60ca8d79740416e4d3f5df9272a6d7d0ee2573b8ba0a1e788a6e3d2a2.jpg","date":"Jul 22, 2023","gps":null,"ben":false,"source":"Same-day Ha Long Bay photo; destination-scoped upload","filename":"PXL_20230722_055835975.jpg"}]},{"name":"Hanoi","country":"Vietnam","lat":21.0277,"lng":105.8354,"year":2023,"date":"Jul 23, 2023","note":"Vietnam","photo":"assets/images/69cb9ed67e77d138c439e8bfa05acec7554869e97cafa119be03b836584c56ab.jpg","photos":[{"src":"assets/images/69cb9ed67e77d138c439e8bfa05acec7554869e97cafa119be03b836584c56ab.jpg","date":"Jul 23, 2023","gps":null,"ben":false,"source":"Same-day Hanoi destination photo","filename":"PXL_20230723_082942046.jpg"}]},{"name":"Ninh Binh","country":"Vietnam","lat":20.27,"lng":105.91,"year":2023,"date":"Jul 24, 2023","note":"Vietnam","photo":"assets/images/67549219cf1bdff146a6e3680ef5abe95c5c959ed57ec11791653fe396e70a5b.jpg","photos":[{"src":"assets/images/67549219cf1bdff146a6e3680ef5abe95c5c959ed57ec11791653fe396e70a5b.jpg","date":"Jul 24, 2023","gps":[20.2755694,105.9114833],"ben":true,"source":"Ninh Binh trip photo; Ben identified in matched metadata","filename":"PXL_20230724_042542968.PORTRAIT.jpg"}]},{"name":"Denver","country":"United States","lat":39.7392,"lng":-104.9903,"year":2023,"date":"Sep 23, 2023","note":"Ben’s birthday","photo":"","photoAudit":{"status":"ben-evidence","files":["PXL_20230923_183257990.jpg","PXL_20230923_183259530.jpg"],"pendingImageIntegration":true}},{"name":"Los Cabos","country":"Mexico","lat":22.8905,"lng":-109.9167,"year":2023,"date":"Oct 2023","note":"Los Cabos","photo":""},{"name":"Istanbul","country":"Turkey","lat":41.0082,"lng":28.9784,"year":2023,"date":"2023","note":"Istanbul / Bosphorus / Taksim","photo":"assets/images/d9218b689ede8809fe38f72ea4b6fa4a42fedbd7aea3c58dc7d9aea4a99ed935.jpg"},{"name":"Prambanan","country":"Indonesia","lat":-7.752,"lng":110.491,"year":2023,"date":"2023","note":"Prambanan Temple / Yogyakarta area","photo":""},{"name":"Big Island","country":"United States","lat":19.6,"lng":-155.5,"year":2024,"date":"Jan 2024","note":"Hawaiʻi","photo":"assets/images/4e8159cb009abdaef417f4e6f6350735580f875feed254faa4936f52e7621202.jpg","photos":[{"src":"assets/images/4e8159cb009abdaef417f4e6f6350735580f875feed254faa4936f52e7621202.jpg","date":"Jan 22, 2024","gps":[20.0401028,-155.4404583],"ben":true,"source":"Same GPS/time cluster as Ben-tagged Big Island metadata","filename":"PXL_20240122_211612523.jpg"}]},{"name":"Kauaʻi","country":"United States","lat":22.0964,"lng":-159.5261,"year":2024,"date":"Jul 2024","note":"Hawaiʻi","photo":""},{"name":"Yosemite / High Sierra","country":"United States","lat":37.86,"lng":-119.41,"year":2024,"date":"2024–25","note":"Multiple visits","photo":"assets/images/809f088b3aa832ced768fa040618086e35f60d2decb419491f1c06e54fb2a1f4.jpg","photos":[{"src":"assets/images/809f088b3aa832ced768fa040618086e35f60d2decb419491f1c06e54fb2a1f4.jpg","date":"Jul 25, 2025","gps":[37.7600472,-119.5621028],"ben":false,"source":"Yosemite GPS/date photo","filename":"PXL_20250725_214346391.jpg"}]},{"name":"Maui","country":"United States","lat":20.7984,"lng":-156.3319,"year":2024,"date":"Dec 2024","note":"Hawaiʻi","photo":"assets/images/7ef0c0b726ef97388dedb13c910d94828cec07b6d6cb7634545ebe0d1c448669.jpg","photos":[{"src":"assets/images/7ef0c0b726ef97388dedb13c910d94828cec07b6d6cb7634545ebe0d1c448669.jpg","date":"Dec 22, 2024","gps":[20.7694028,-156.5004306],"ben":true,"source":"Maui GPS/date cluster; Ben trip photo","filename":"PXL_20241222_222523702.MP.jpg"}]},{"name":"Big Sur / Monterey","country":"United States","lat":36.2704,"lng":-121.8081,"year":2025,"date":"Jan 2025","note":"California coast","photo":""},{"name":"Whistler","country":"Canada","lat":50.1163,"lng":-122.9574,"year":2025,"date":"Sep 2025","note":"Whistler, BC","photo":""},{"name":"Jerusalem","country":"Israel","lat":31.7683,"lng":35.2137,"year":0,"date":"Date to confirm","note":"Jerusalem · preferred Ben/Josh hero confirmed by Ginny; current connected image retained until that uploaded hero is linked","photo":"assets/images/d56f2ca44075a58195f948919395b3a0cfcc3e68eac792d0b3c6967fe5cc0d79.jpg"},{"name":"Germany","country":"Germany","lat":50.1,"lng":7.6,"year":2006,"date":"2006","note":"Germany trip — exact city/castle to refine","photo":"assets/images/258d41bdd05d800a1f24c52cbbc2e3f9bb0703d8fc0643224f57d308bc29c874.jpg"},{"name":"Taipei","country":"Taiwan","lat":25.0336778,"lng":121.5648306,"year":2023,"date":"Jul 28, 2023","note":"Taipei","photos":[{"src":"assets/images/24adb3c9012a02f2b460f7e7246ea7a4a9e31b6532750fa49211cad91e5d1c31.jpg","date":"Jul 28, 2023","gps":[25.0336778,121.5648306],"ben":true,"source":"GPS + Ben identified in metadata","filename":"PXL_20230728_120258015.jpg"}],"photo":"assets/images/24adb3c9012a02f2b460f7e7246ea7a4a9e31b6532750fa49211cad91e5d1c31.jpg"},{"name":"Wulai","country":"Taiwan","lat":24.8400389,"lng":121.5391528,"year":2023,"date":"Jul 28, 2023","note":"Wulai","photos":[{"src":"assets/images/37c802bceb9562cf57fc3d9a8d754f129a1c0dd1cae9a43f8804e7f02e0b3d83.jpg","date":"Jul 28, 2023","gps":[24.8400389,121.5391528],"ben":true,"source":"GPS + Ben identified in metadata","filename":"PXL_20230728_062808991.MP.jpg"}],"photo":"assets/images/37c802bceb9562cf57fc3d9a8d754f129a1c0dd1cae9a43f8804e7f02e0b3d83.jpg"},{"name":"Fiordland National Park","country":"New Zealand","lat":-45.42,"lng":167.72,"year":2019,"date":"Jul 15, 2019","note":"Confirmed by Ginny from Ben’s photo","photoSource":"Confirmed by Ginny from Ben’s photo","photo":"assets/images/8bcbfd805498b8ed8e3a277e5e2797f5f0f25acc7d582c9788ee137bbc773958.jpg","photos":[{"src":"assets/images/8bcbfd805498b8ed8e3a277e5e2797f5f0f25acc7d582c9788ee137bbc773958.jpg","place":"Fiordland National Park","date":"Jul 15, 2019","source":"Confirmed by Ginny from Ben’s photo"}]},{"name":"Makarora","country":"New Zealand","lat":-44.23,"lng":169.23,"year":2019,"date":"Jul 16, 2019","note":"Otago Region · Confirmed by Ginny from Ben’s photo","photoSource":"Confirmed by Ginny from Ben’s photo","photo":"assets/images/ccdedbf545674bfd216115984d5bc01602a4bd6138fb24e5cb921c6d18b706da.jpg","photos":[{"src":"assets/images/ccdedbf545674bfd216115984d5bc01602a4bd6138fb24e5cb921c6d18b706da.jpg","place":"Makarora","date":"Jul 16, 2019","source":"Confirmed by Ginny from Ben’s photo"}]},{"name":"Te Miko / Paparoa","country":"New Zealand","lat":-42.12,"lng":171.33,"year":2019,"date":"Jul 19, 2019","note":"Te Miko / Paparoa area · Confirmed by Ginny from Ben’s photos","photoSource":"Confirmed by Ginny from Ben’s photo","photo":"assets/images/7ed6d253ba5b15c1d994a0d508dd121cb7edd112bfce64125c8b6f82d242830a.jpg","photos":[{"src":"assets/images/7ed6d253ba5b15c1d994a0d508dd121cb7edd112bfce64125c8b6f82d242830a.jpg","place":"Te Miko / Paparoa","date":"Jul 19, 2019","source":"Confirmed by Ginny from Ben’s photo"},{"src":"assets/images/b771e820011a5ea2c856405fd8e53b338dccaac7713d45bf68be0a736e61521f.jpg","place":"Te Miko / Paparoa","date":"Jul 19, 2019","source":"Confirmed by Ginny from Ben’s photo"}]},{"name":"Christchurch","country":"New Zealand","lat":-43.53,"lng":172.63,"year":2019,"date":"Jul 20, 2019","note":"Includes Christchurch Botanic Gardens · Confirmed by Ginny from Ben’s photos","photoSource":"Confirmed by Ginny from Ben’s photo","photo":"assets/images/d36b57433f7de064f313ef263778bb88f0a7c53b79edfdb5626dad9c5dd547bc.jpg","photos":[{"src":"assets/images/d36b57433f7de064f313ef263778bb88f0a7c53b79edfdb5626dad9c5dd547bc.jpg","place":"Christchurch","date":"Jul 20, 2019","source":"Confirmed by Ginny from Ben’s photo"},{"src":"assets/images/9bd531ef5955fcfdad099772e044e3a45425e243aad59ad3a492a75a01c46349.jpg","place":"Christchurch","date":"Jul 20, 2019","source":"Confirmed by Ginny from Ben’s photo"},{"src":"assets/images/0f27a18048e25993dd817f3b3d85209f05cb089a73dd3fd095c148b12dddf640.jpg","place":"Christchurch","date":"Jul 20, 2019","source":"Confirmed by Ginny from Ben’s photo"}]},{"name":"Centro Cultural Bastión del Carmen","country":"Uruguay","lat":-34.47,"lng":-57.84,"year":2008,"date":"Jul 30, 2008","note":"Uruguay visit · Confirmed by Ginny from Ben’s photos","photoSource":"Confirmed by Ginny from Ben’s photo","photo":"assets/images/c08907b82be66dcb8a550251f9ffbc6caf975e4e1e4a2bdeabc6a5d53659966a.jpg","photos":[{"src":"assets/images/c08907b82be66dcb8a550251f9ffbc6caf975e4e1e4a2bdeabc6a5d53659966a.jpg","place":"Centro Cultural Bastión del Carmen","date":"Jul 30, 2008","source":"Confirmed by Ginny from Ben’s photo"},{"src":"assets/images/422b094e57259d1c5aaff730c298bf378ea3b95dcc7d57ea8492fac8ba53ab98.jpg","place":"Centro Cultural Bastión del Carmen","date":"Jul 30, 2008","source":"Confirmed by Ginny from Ben’s photo"}]},{"name":"Oaxaca City","country":"Mexico","lat":17.073,"lng":-96.726,"year":0,"date":"Date to confirm","note":"Six Oaxaca City photos confirmed by Ginny","photoSource":"Confirmed by Ginny from Ben’s photo","photo":"assets/images/242e52a970780c2663ca88c726372203eb3c08c069bfa4497421503b4872a2d5.jpg","photos":[{"src":"assets/images/242e52a970780c2663ca88c726372203eb3c08c069bfa4497421503b4872a2d5.jpg","place":"Oaxaca City","date":"Date to confirm","source":"Confirmed by Ginny from Ben’s photo"},{"src":"assets/images/adc8162e084ddc93d9f5ada1e3beb73387835db3495f355c8d379c0cb60dfaaf.jpg","place":"Oaxaca City","date":"Date to confirm","source":"Confirmed by Ginny from Ben’s photo"},{"src":"assets/images/94ff732dec200b9a8001bda06b8939a1d21456fd94e19dfead079c46050531f2.jpg","place":"Oaxaca City","date":"Date to confirm","source":"Confirmed by Ginny from Ben’s photo"},{"src":"assets/images/d0d18ea37644fb302b39cb6bcb802e3f5e365b9bbc9d8d335b720775058d03ac.jpg","place":"Oaxaca City","date":"Date to confirm","source":"Confirmed by Ginny from Ben’s photo"},{"src":"assets/images/576cf2c3dcdf8762c2a07ea887466d2809d061c29b504323e7fceb4f6eeb636e.jpg","place":"Oaxaca City","date":"Date to confirm","source":"Confirmed by Ginny from Ben’s photo"},{"src":"assets/images/eca5112d640447cd6179a3af009d2893fc04591426021b8eeec8da9fa657a9a5.jpg","place":"Oaxaca City","date":"Date to confirm","source":"Confirmed by Ginny from Ben’s photo"}]}];
const INITIAL_COUNTRY_REGISTRY = [
 {name:"Morocco",continent:"Africa"},
 {name:"Cambodia",continent:"Asia"},{name:"Hong Kong",continent:"Asia",territory:true},{name:"Indonesia",continent:"Asia"},{name:"Israel",continent:"Asia"},{name:"Japan",continent:"Asia"},{name:"Laos",continent:"Asia"},{name:"Philippines",continent:"Asia"},{name:"Taiwan",continent:"Asia"},{name:"Thailand",continent:"Asia"},{name:"Vietnam",continent:"Asia"},
 {name:"Albania",continent:"Europe"},{name:"Austria",continent:"Europe"},{name:"Belgium",continent:"Europe"},{name:"Bosnia & Herzegovina",continent:"Europe"},{name:"Croatia",continent:"Europe"},{name:"Czech Republic",continent:"Europe"},{name:"Denmark",continent:"Europe"},{name:"France",continent:"Europe"},{name:"Germany",continent:"Europe"},{name:"Italy",continent:"Europe"},{name:"Monaco",continent:"Europe"},{name:"Montenegro",continent:"Europe"},{name:"Portugal",continent:"Europe"},{name:"Slovenia",continent:"Europe"},{name:"Spain",continent:"Europe"},{name:"Switzerland",continent:"Europe"},{name:"Turkey",continent:"Europe"},{name:"United Kingdom",continent:"Europe"},
 {name:"Belize",continent:"North America"},{name:"Canada",continent:"North America"},{name:"Costa Rica",continent:"North America"},{name:"Guatemala",continent:"North America"},{name:"Mexico",continent:"North America"},{name:"United States",continent:"North America"},
 {name:"Australia",continent:"Oceania"},{name:"New Zealand",continent:"Oceania"},
 {name:"Argentina",continent:"South America"},{name:"Chile",continent:"South America"},{name:"Peru",continent:"South America",status:"Confirmed by Ginny — trip details needed"},{name:"Uruguay",continent:"South America"}
];
const CONTINENT_ORDER=["Africa","Asia","Europe","North America","South America","Oceania"];
function loadCountryRegistry(){try{const x=JSON.parse(localStorage.getItem(COUNTRY_KEY)||'null');return Array.isArray(x)?x:INITIAL_COUNTRY_REGISTRY.map(x=>({...x,status:x.status||'Confirmed'}))}catch(e){return INITIAL_COUNTRY_REGISTRY.map(x=>({...x,status:x.status||'Confirmed'}))}}
function saveCountryRegistry(r){localStorage.setItem(COUNTRY_KEY,JSON.stringify(r));queueCloudSave()}
function guessContinent(country){const c=normCountry(country);for(const r of INITIAL_COUNTRY_REGISTRY)if(normCountry(r.name)===c)return r.continent;return 'Other'}
function registerCountry(country,continent){country=String(country||'').trim();if(!country||normCountry(country)==='location to confirm')return;let r=loadCountryRegistry();if(!r.some(x=>normCountry(x.name)===normCountry(country))){r.push({name:country,continent:continent||guessContinent(country),status:'Added in Ben’s World'});saveCountryRegistry(r)}}
function registryCountries(){
  // Edit 2: the confirmed lifetime registry is cumulative, while countries introduced
  // only by Add Trip are derived from the current living trip data. This prevents a
  // deleted test trip from leaving a ghost country behind, and prevents confirmed
  // countries such as Peru from disappearing just because they have no pushpin.
  const byName=new Map(INITIAL_COUNTRY_REGISTRY.map(x=>[normCountry(x.name),{...x,status:x.status||'Confirmed'}]));
  ALL.forEach(d=>{
    const name=String(d.country||'').trim();
    const key=normCountry(name);
    if(!name||key==='location to confirm')return;
    if(!byName.has(key)) byName.set(key,{name,continent:guessContinent(name),status:'Added in Ben’s World'});
  });
  return [...byName.values()];
}
let current=[...ALL], map=null, marker=null;
// Mobile pin-tap repair: preserve the small red WebGL point, but give it a
// larger invisible, geographically anchored tap target. A tap opens the same
// canonical destination card used by the menus. Dragging across the target
// does not count as a tap.
function makePinTapTarget(d){
  const hit=document.createElement('div');
  hit.setAttribute('aria-label','Open '+(d.name||'destination'));
  hit.style.cssText='width:46px;height:46px;border-radius:50%;background:transparent;cursor:pointer;pointer-events:auto;touch-action:manipulation;transform:translate(-50%,-50%);position:relative;';
  if(window.matchMedia('(max-width:760px), (pointer:coarse)').matches){
    const dot=document.createElement('span');
    dot.setAttribute('aria-hidden','true');
    dot.style.cssText='position:absolute;left:50%;top:50%;width:8px;height:8px;border-radius:50%;background:#d71920;transform:translate(-50%,-50%);box-shadow:0 0 0 1px rgba(255,255,255,.75),0 1px 3px rgba(0,0,0,.8);pointer-events:none;';
    hit.appendChild(dot);
  }
  let sx=0,sy=0,moved=false;
  const start=e=>{ stopGlobeRotation(); const p=(e.touches&&e.touches[0])||e; sx=p.clientX||0; sy=p.clientY||0; moved=false; };
  const move=e=>{ const p=(e.touches&&e.touches[0])||e; if(Math.hypot((p.clientX||0)-sx,(p.clientY||0)-sy)>9)moved=true; };
  const open=e=>{ if(moved)return; if(e.cancelable)e.preventDefault(); e.stopPropagation(); stopGlobeRotation(); renderDestinationCard(d); };
  hit.addEventListener('pointerdown',start,{passive:true});
  hit.addEventListener('pointermove',move,{passive:true});
  hit.addEventListener('click',open,false);
  hit.addEventListener('touchstart',start,{passive:true});
  hit.addEventListener('touchmove',move,{passive:true});
  hit.addEventListener('touchend',open,{passive:false});
  return hit;
}
let globe; try { if(typeof Globe!=='function') throw new Error('3-D library unavailable'); globe=Globe()(document.getElementById('globe')).globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg').backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png').htmlElementsData(current.filter(d=>Number.isFinite(d.lat)&&Number.isFinite(d.lng))).htmlElement(makePinTapTarget).htmlLat('lat').htmlLng('lng').htmlAltitude(0.015).pointsData(current.filter(d=>Number.isFinite(d.lat)&&Number.isFinite(d.lng))).pointLat('lat').pointLng('lng').pointAltitude(0).pointRadius(.22).pointResolution(12).pointColor(()=> '#d71920').pointLabel(d=>d.name).onPointClick(d=>{stopGlobeRotation();renderDestinationCard(d);}); globe.pointOfView({lat:24,lng:5,altitude:2.2}); globe.controls().enableZoom=true; globe.controls().enableRotate=true; globe.controls().enablePan=false; globe.controls().zoomSpeed=1.15; globe.controls().minDistance=100.15; globe.controls().maxDistance=1200; if(globe.controls().touches){ globe.controls().touches.ONE=0; globe.controls().touches.TWO=2; } globe.controls().autoRotate=true; globe.controls().autoRotateSpeed=.18; const stopGlobe=()=>{if(globe)globe.controls().autoRotate=false}; globe.controls().addEventListener('start',stopGlobe); document.getElementById('globe').addEventListener('pointerdown',stopGlobe,{passive:true}); document.getElementById('globe').addEventListener('touchstart',stopGlobe,{passive:true}); } catch(e) { document.getElementById('globe').innerHTML='<div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:30px"><div><div style="font-size:min(55vw,55vh)">🌎</div><b>Ben’s World</b><br><small>The 3-D map needs an internet connection. The travel menus still work.</small></div></div>'; }
enableChromebookGlobeZoom();
function uniq(a){return [...new Set(a)]}
function normCountry(x){return String(x||'').trim().replace(/\s+/g,' ').toLocaleLowerCase()}
const CANONICAL_TRAVEL_YEARS=[2004,2006,2008,2009,2010,2016,2019,2021,2023,2024,2025,2026];
// Count only specifically identified cities; non-city destinations remain on the map but do not inflate this statistic.
const CANONICAL_CITIES=['Toulouse','Brussels','Lisbon','Ljubljana','Innsbruck','Milan','Schio','Sydney','Christchurch','Sarajevo','Mostar','Dubrovnik','Zagreb','Paris','Lille','Vence','Copenhagen','Prague','Luang Prabang','Ho Chi Minh City','Hoi An','Da Nang','Hanoi','Ninh Binh','Taipei','Denver','Istanbul','Jerusalem','Tel Aviv','Eilat','Haifa','Buenos Aires','Mexico City','Oaxaca','Oaxaca City','Vancouver'];
const TRIP_DATE_REGISTRY={
  2004:[{name:'Toulouse, France',date:'Summer 2004',destinations:['Toulouse']}],
  2006:[{name:'Belgium & Germany',date:'Aug 2006',destinations:['Brussels','Rhine River Castle Cruise']}],
  2008:[{name:'Uruguay',country:'Uruguay',date:'Jul 30, 2008',destinations:['Centro Cultural Bastión del Carmen']}],
  2009:[{name:'Israel',country:'Israel',date:'Late Dec 2009–early Jan 2010',destinations:['Jerusalem','Tel Aviv','Jaffa','Sea of Galilee','Red Sea / Eilat','Haifa']}],
  2010:[{name:'Israel (continued)',country:'Israel',date:'Early Jan 2010',destinations:['Jerusalem','Tel Aviv','Jaffa','Sea of Galilee','Red Sea / Eilat','Haifa']}],
  2016:[{name:'Slovenia / Italy / Austria',date:'Jul 2016',destinations:['Ljubljana','Lake Bled','Dolomites','Innsbruck']}],
  2019:[{name:'Australia & New Zealand',date:'2019',destinations:['Sydney','Queensland','Fiordland National Park','Makarora','Te Miko / Paparoa','Christchurch']}],
  2021:[{name:'Balkans',date:'Jul 2021',destinations:['Sarajevo','Mostar','Dubrovnik','Zagreb','Sveti Stefan','Albania']}],
  2023:[
    {name:'Paris',date:'Feb 2023',destinations:['Paris']},
    {name:'Portugal',date:'2023 — exact dates being reconciled',destinations:['Lisbon']},
    {name:'Southern Thailand',date:'Apr 17, 2023',destinations:['Southern Thailand']},
    {name:'Asia journey',date:'Jul 14–28, 2023 (documented GPS range)',destinations:['Ho Chi Minh City','Hoi An','Da Nang','Ha Long Bay','Hanoi','Ninh Binh','Taipei','Wulai']},
    {name:'Other 2023 international travel',date:'2023 — exact trip dates still being reconciled',destinations:['Copenhagen','Prague','Cambodia / Angkor','Luang Prabang','Istanbul','Prambanan']},
    {name:'Denver',date:'Sep 23, 2023',destinations:['Denver']},
    {name:'Los Cabos',date:'Oct 3, 2023',destinations:['Los Cabos']}
  ],
  2024:[
    {name:'Big Island, Hawaiʻi',date:'Jan 22, 2024',destinations:['Big Island, Hawaiʻi']},
    {name:'Kauaʻi',date:'Jul 1, 2024',destinations:['Kauaʻi']},
    {name:'Yosemite / High Sierra',date:'Aug 17, 2024',destinations:['Yosemite / High Sierra']},
    {name:'New York',date:'Sep 21–22, 2024',destinations:['Hudson / Columbia County, NY']},
    {name:'Maui',date:'Dec 22, 2024',destinations:['Maui']}
  ],
  2025:[
    {name:'Big Sur / Monterey',date:'Jan 26, 2025',destinations:['Big Sur / Monterey']},
    {name:'Washington',date:'Feb 17, 2025',destinations:['Seattle Area']},
    {name:'Sierra',date:'Mar 1, 2025',destinations:['Sierra']},
    {name:'Yosemite',date:'Jul 25–26, 2025',destinations:['Yosemite Valley']},
    {name:'Whistler',date:'Sep 11–12, 2025',destinations:['Whistler']},
    {name:'Japan',date:'Dec 24–25, 2025',destinations:['Japan — Macaques']}
  ],
  2026:[{name:'2026 travel',date:'2026 — dates/details still being reconciled',destinations:[]}]
};
function canonicalYears(){
  const years=new Set(CANONICAL_TRAVEL_YEARS);
  loadAddedTrips().forEach(t=>{[t.start,t.end].forEach(v=>{const m=String(v||'').match(/(?:19|20)\d{2}/g);(m||[]).forEach(y=>years.add(Number(y)))})});
  return [...years].sort((a,b)=>a-b);
}
function knownYears(data){return canonicalYears()}
function masterCounts(){return {countries:registryCountries().length,cities:CANONICAL_CITIES.length,years:canonicalYears().length}}
function updateNums(){const n=masterCounts();document.getElementById('countries').textContent=n.countries;document.getElementById('cities').textContent=n.cities+'+';document.getElementById('years').textContent=n.years;const yl=document.getElementById('yearsLabel');if(yl)yl.textContent='DOCUMENTING '+n.years+' TRAVEL YEAR'+(n.years===1?'':'S');}
function openCountriesTerritories(){closeMobileMenu();renderCountryRegistry();document.getElementById('countriesBack').style.display='flex'}
function closeCountriesTerritories(){document.getElementById('countriesBack').style.display='none'}
function escJs(v){return String(v||'').replaceAll('\\','\\\\').replaceAll("'","\\'")}
function renderCountryRegistry(){
 const box=document.getElementById('countryRegistryList'),details=document.getElementById('countryRegistryDetails');details.style.display='none';let r=registryCountries(),html='';
 for(const cont of CONTINENT_ORDER.concat(['Other'])){
  const xs=r.filter(x=>(x.continent||'Other')===cont).sort((a,b)=>a.name.localeCompare(b.name));if(!xs.length)continue;
  html+=`<div class="continent">${cont}</div>`+xs.map(x=>{const ds=ALL.filter(d=>normCountry(d.country)===normCountry(x.name));return `<div class="countryrow" role="button" tabindex="0" onclick="openCountry('${escJs(x.name)}')" oncontextmenu="event.preventDefault();editCountryEntry('${escJs(x.name)}')" onkeydown="if(event.key==='Enter')openCountry('${escJs(x.name)}')">${countryPhotoThumbnailHtml(x.name)}<span class="countryname">${x.name}${x.territory?' <span class="badge">territory</span>':''}</span><span class="countrymeta">${ds.length?ds.length+' mapped place'+(ds.length===1?'':'s'):'trip details to add'} &nbsp; <button title="Edit" aria-label="Edit ${x.name}" onclick="event.stopPropagation();editCountryEntry('${escJs(x.name)}')">✎</button></span></div>`}).join('')
 }
 box.innerHTML=html
}
function openCountry(name){
 const ds=ALL.filter(x=>normCountry(x.country)===normCountry(name)).sort((a,b)=>(a.year||9999)-(b.year||9999)||a.name.localeCompare(b.name));
 if(ds.length===1 && Number.isFinite(ds[0].lat)&&Number.isFinite(ds[0].lng)){closeCountriesTerritories();openPlace(ds[0]);return}
 showCountryRegistryDetails(name)
}
function showCountryRegistryDetails(name){
 const d=document.getElementById('countryRegistryDetails'),r=registryCountries().find(x=>x.name===name),ds=ALL.filter(x=>normCountry(x.country)===normCountry(name)).sort((a,b)=>(a.year||9999)-(b.year||9999)||a.name.localeCompare(b.name));
 d.style.display='block';
 d.innerHTML=`<div class="countryDetailHeading">${countryPhotoThumbnailHtml(name)}<div><b>${escHtml(name)}</b><div class="note">${escHtml(r?.status||'Confirmed')}</div></div><button onclick="editCountryEntry('${escJs(name)}')">✎ Edit / add details</button></div>`+(ds.length?`<div style="margin-top:8px">${ds.map(x=>`<div class="listitem" style="display:flex;align-items:center;gap:8px"><span style="cursor:pointer;flex:1" onclick="closeCountriesTerritories();openPlaceByKey('${escJs(x.name)}','${escJs(x.country)}',${JSON.stringify(x.year||'')})">📍 <b>${escHtml(x.name)}</b>${x.year?' · '+x.year:''}</span><button onclick="event.stopPropagation();editPlaceByKey('${escJs(x.name)}','${escJs(x.country)}',${JSON.stringify(x.year||'')})">✎</button></div>`).join('')}</div>`:`<div class="note" style="margin-top:8px">Confirmed visited. Destination, dates and photos can be added later.</div>`);
 d.scrollIntoView({behavior:'smooth',block:'nearest'})
}
function findPlaceKey(name,country,year){return ALL.find(x=>x.name===name&&normCountry(x.country)===normCountry(country)&&String(x.year||'')===String(year||''))||ALL.find(x=>x.name===name&&normCountry(x.country)===normCountry(country))}
function openPlaceByKey(name,country,year){const x=findPlaceKey(name,country,year);if(x)openPlace(x)}
function editPlaceByKey(name,country,year){const x=findPlaceKey(name,country,year);if(!x)return;openEditRecords();const sel=document.getElementById('editRecord');let found=-1;[...sel.options].forEach((o,i)=>{if(o.dataset.kind==='base'&&x._baseId&&o.value===x._baseId)found=i});if(found<0){[...sel.options].forEach((o,i)=>{if(o.textContent.includes(x.name+' — '+x.country))found=i})}if(found>=0){sel.selectedIndex=found;loadEditRecord()}}
function editCountryEntry(name){
 const ds=ALL.filter(x=>normCountry(x.country)===normCountry(name));
 if(ds.length){closeCountriesTerritories();editPlaceByKey(ds[0].name,ds[0].country,ds[0].year);return}
 closeCountriesTerritories();openAddTrip();setTimeout(()=>{if(document.getElementById('tripName'))document.getElementById('tripName').value=name+' trip';if(document.getElementById('tripPlace'))document.getElementById('tripPlace').value=name;},50)
}
function openDates(){closeMobileMenu();renderDates();document.getElementById('datesBack').style.display='flex'}
function closeDates(){document.getElementById('datesBack').style.display='none'}
function escHtml(v){return String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))}
function renderDates(){
  const box=document.getElementById('datesList');
  const ys=canonicalYears().slice().sort((a,b)=>b-a);
  box.innerHTML=ys.map(y=>{
    const trips=[...(TRIP_DATE_REGISTRY[y]||[])];
    // User-added trips are nested under their documented year too.
    loadAddedTrips().forEach(t=>{const m=String(t.start||t.end||'').match(/(?:19|20)\d{2}/);if(m&&Number(m[0])===Number(y))trips.push({name:t.name,date:t.start?((t.end&&t.end!==t.start)?formatFlexibleDate(t.start)+' → '+formatFlexibleDate(t.end):formatFlexibleDate(t.start)):'Date to add',destinations:t.city?[t.city]:[]})});
    const tripHtml=trips.length?trips.map((t,ti)=>{
      const dests=(t.destinations||[]).map(n=>ALL.find(d=>d.name===n)).filter(Boolean);
      return `<div style="margin:7px 0 10px 12px;padding-left:10px;border-left:2px solid #ffffff20"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><div><b>✈️ ${escHtml(t.name)}</b>${t.country?` <span class="badge">🌍 ${escHtml(t.country)}</span>`:''} <span class="badge">${escHtml(t.date||'Date to add')}</span></div><button title="Edit trip details" aria-label="Edit trip details" onclick="event.stopPropagation();closeDates();openEditRecords()">✎</button></div>${dests.length?dests.map(d=>{const idx=ALL.indexOf(d);return `<div class="countryrow" onclick="openDateDestination(${idx})"><span class="countryname">📍 ${escHtml(d.name)}</span><span class="countrymeta">${escHtml(d.country||'')}${d.date?' · '+escHtml(d.date):''} &nbsp; <button title="Edit" aria-label="Edit ${escHtml(d.name)}" onclick="event.stopPropagation();closeDates();editPlaceByKey('${escJs(d.name)}','${escJs(d.country)}',${JSON.stringify(d.year||'')})">✎</button></span></div>`}).join(''):'<div class="note" style="margin-top:5px">Trip documented; destination details can be added or completed later.</div>'}</div>`
    }).join(''):'<div class="note" style="margin:7px 0 10px 12px">Travel year documented; trip details still need to be added.</div>';
    return `<div class="continent" style="cursor:pointer" onclick="toggleDateYear('${y}')">${y} <span style="font-size:11px;opacity:.7">· ${trips.length} trip${trips.length===1?'':'s'}</span></div><div id="dateyear_${y}" style="display:block">${tripHtml}</div>`
  }).join('');
}
function toggleDateYear(y){const el=document.getElementById('dateyear_'+y);if(el)el.style.display=el.style.display==='none'?'block':'none'}
function openDateDestination(idx){const d=ALL[idx];if(!d)return;closeDates();const s=document.getElementById('yearSelect');if(s)s.value=String(d.year||'all');if(d.year)filterYear(d.year);openPlace(d)}
function setupYears(){const ys=canonicalYears(); const s=document.getElementById('yearSelect'); s.innerHTML='<option value="all">Travel by year</option>'; ys.forEach(y=>{let o=document.createElement('option');o.value=y;o.textContent=y;s.appendChild(o)}); const b=document.getElementById('yearBtns');b.innerHTML='';ys.forEach(y=>{let x=document.createElement('button');x.textContent=y;x.onclick=()=>filterYear(y);b.appendChild(x)})}
function filterYear(y){document.getElementById('detailMapStage').style.display='none';current=(y==='all'||y==='')?[...ALL]:ALL.filter(d=>String(d.year)===String(y)||(String(d.year)==='2009–10'&&(String(y)==='2009'||String(y)==='2010')));if(globe){const mappable=current.filter(d=>Number.isFinite(d.lat)&&Number.isFinite(d.lng));globe.pointsData(mappable);}updateNums();renderList();document.getElementById('place').textContent=y==='all'?"Ben's travels":`Ben's travels — ${y}`;document.getElementById('date').textContent=`${current.length} documented destination${current.length===1?'':'s'}`;document.getElementById('note').textContent='Tap a pushpin to open trip information, photo status and the detailed 2-D map.';document.getElementById('map').style.display='none';}
function restartGlobeRotation(){if(globe){globe.controls().autoRotate=true;globe.controls().autoRotateSpeed=.18}}
function stopGlobeRotation(){if(globe)globe.controls().autoRotate=false}
function zoomGlobe(direction){
 if(!globe)return; stopGlobeRotation();
 const pov=globe.pointOfView();
 const currentAlt=Number.isFinite(pov.altitude)?pov.altitude:2.2;
 const factor=direction<0?0.72:1.38; const next=Math.max(0.08,Math.min(5.5,currentAlt*factor));
 globe.pointOfView({lat:pov.lat,lng:pov.lng,altitude:next},220);
}
function enableChromebookGlobeZoom(){
 const el=document.getElementById('globe'); if(!el)return;
 if(!window.matchMedia('(pointer:fine)').matches)return;
 el.addEventListener('wheel',e=>{e.preventDefault();e.stopPropagation();stopGlobeRotation();zoomGlobe(e.deltaY>0?1:-1)},{capture:true,passive:false});
}
function resetAll(){document.getElementById('detailMapStage').style.display='none';document.getElementById('yearSelect').value='all';filterYear('all');if(globe) globe.pointOfView({lat:24,lng:5,altitude:2.2},900)}

function tripForDestination(d){
  const y=Number(d.year)||0;
  const groups=TRIP_DATE_REGISTRY[y]||[];
  const n=String(d.name||'').toLowerCase();
  return groups.find(g=>(g.destinations||[]).some(x=>{const q=String(x).toLowerCase();return n===q||n.includes(q)||q.includes(n)}))||null;
}
let activePhotoGallery=[];let activePhotoIndex=0;let activeDestination=null;

// ===== BIRTHDAY PRIMARY PHOTO RECOVERY PASS 1 =====
const PRIMARY_RECOVERED_PHOTOS = {"Lisbon": [{"src":"assets/images/c2d7d3ad5d2753d6f3e3a1c7f426e3a9fab856c486ffad4a296b9fdeb0f6730b.jpg","date":"2023","source":"Ginny-confirmed Ben Lisbon 2023 upload","filename":"IMG_8968.JPG"},{"src":"assets/images/f7b8c1c8c2b9cf8feedd62c7b318eb86a9a8dadca0fcede504f2871593be8580.jpg","date":"2023","source":"Ginny-confirmed Ben Lisbon 2023 upload","filename":"IMG_8988.JPG"},{"src":"assets/images/af580efc004b77f3fb6087549e42fbf66db407bdec3811c5d8e13d9b23af69ca.jpg","date":"2023","source":"Ginny-confirmed Ben Lisbon 2023 upload","filename":"IMG_8974(3).JPG"},{"src":"assets/images/e99b48893a4da9dea6471c79123fd10bf99a5463fa1c27c86d8779d88807083e.jpg","date":"2023","source":"Ginny-confirmed Ben Lisbon 2023 upload","filename":"IMG_8971.JPG"},{"src":"assets/images/8d460ce4e8b446251c7de5fd6fd7351370391676afd8a7c5c4c5d86688518410.jpg","date":"2023","source":"Ginny-confirmed Ben Lisbon 2023 upload","filename":"IMG_8966.JPG"},{"src":"assets/images/cb7d1780817fe1a3791d0d3518c8a8082cb40cd3e5e157c194daa320ee367840.jpg","date":"2023","source":"Ginny-confirmed Ben Lisbon 2023 upload","filename":"IMG_8950.JPG"},{"src":"assets/images/e8225d77993be27026b2beb108630722c943f253ddc839db9952bf6ec825bca3.jpg","date":"2023","source":"Ginny-confirmed Ben Lisbon 2023 upload","filename":"IMG_8949.JPG"},{"src":"assets/images/5ee916b6939cb7415ff27abbde131e55adb329c48280519e60f5356d99e45891.jpg","date":"2023","source":"Ginny-confirmed Ben Lisbon 2023 upload","filename":"IMG_8945.JPG"},{"src":"assets/images/8c2ecd029112e5f8bae49630f5edf8a76af53811b6e43a2489dbab58b1efe6ab.jpg","date":"2023","source":"Ginny-confirmed Ben Lisbon 2023 upload","filename":"IMG_8948.JPG"},{"src":"assets/images/ceeb3911a34e98ad7a950f1ad943fb78bbf86bc09fe35e1259e4b5f96a74f1ba.jpg","date":"2023","source":"Ginny-confirmed Ben Lisbon 2023 upload","filename":"IMG_8946.jpg"}], "Ha Long Bay": [{"src": "assets/images/2a6dcdb93569bf40564f220fa17f3b59b880afacc2f228c407cd6dbcf28d2ee7.jpg", "date": "20230722"}, {"src": "assets/images/1959e7a60ca8d79740416e4d3f5df9272a6d7d0ee2573b8ba0a1e788a6e3d2a2.jpg", "date": "20230722"}], "Ninh Binh": [{"src": "assets/images/67549219cf1bdff146a6e3680ef5abe95c5c959ed57ec11791653fe396e70a5b.jpg", "date": "20230724"}], "Wulai": [{"src": "assets/images/37c802bceb9562cf57fc3d9a8d754f129a1c0dd1cae9a43f8804e7f02e0b3d83.jpg", "date": "20230728"}], "Taipei": [{"src": "assets/images/24adb3c9012a02f2b460f7e7246ea7a4a9e31b6532750fa49211cad91e5d1c31.jpg", "date": "20230728"}], "Big Island, Hawaiʻi": [{"src": "assets/images/4e8159cb009abdaef417f4e6f6350735580f875feed254faa4936f52e7621202.jpg", "date": "20240122"}], "Maui": [{"src": "assets/images/7ef0c0b726ef97388dedb13c910d94828cec07b6d6cb7634545ebe0d1c448669.jpg", "date": "20241222"}], "Yosemite": [{"src": "assets/images/809f088b3aa832ced768fa040618086e35f60d2decb419491f1c06e54fb2a1f4.jpg", "date": "20250725"}], "Hanoi": [{"src": "assets/images/69cb9ed67e77d138c439e8bfa05acec7554869e97cafa119be03b836584c56ab.jpg", "date": "20230723"}]};


// Photo-recovery pass 3: previously established Toulouse destination.
// Date remains unresolved here; the uploaded image's file date is not used as Ben's trip date.
ALL.push({name:"Toulouse",country:"France",lat:43.6047,lng:1.4442,year:2004,date:"~2004",note:"Older France trip; destination previously established",photos:[]});


// Photo-recovery pass 3 — exact destination-scoped additions from current uploaded batch.
PRIMARY_RECOVERED_PHOTOS['Albania'] = (PRIMARY_RECOVERED_PHOTOS['Albania'] || []).concat([
{src:'assets/images/344786d50a6f3506e9bd582f13fe6300ef42f7cb9abc563b5a3dc40a6ced2830.jpg',filename:'PXL_20210725_114932802.MP(1).jpg',source:'Current uploaded batch; user/location-confirmed destination association'},
{src:'assets/images/b7fa86caceaccc29cf57b3c6ed8b8228f3ede96a97ad7b9dd9d88afa03803308.jpg',filename:'PXL_20210725_155934942.jpg',source:'Current uploaded batch; user/location-confirmed destination association'},
{src:'assets/images/038a20d56b011081cb0c7336b64b1a2830f166fb59cbe0de98eceb66f546dab8.jpg',filename:'PXL_20210725_161517416.jpg',source:'Current uploaded batch; user/location-confirmed destination association'},
{src:'assets/images/29e5c96df43521af83ef9d903a1b09b7da637fb8d705c646d72cca41e573a014.jpg',filename:'PXL_20210725_162354094.jpg',source:'Current uploaded batch; user/location-confirmed destination association'},
{src:'assets/images/a9242af1f68c2bfff12e6f32e7c5916e95b80f3e781f979cfdf68f040d0739ed.jpg',filename:'PXL_20210727_124048243.jpg',source:'Current uploaded batch; user/location-confirmed destination association'},
]);
PRIMARY_RECOVERED_PHOTOS['Luang Prabang'] = (PRIMARY_RECOVERED_PHOTOS['Luang Prabang'] || []).concat([
{src:'assets/images/5cd5921b5cf6c637800b8893baa5e09f6b8442374837c7108c2de5e6661677a4.jpg',filename:'IMG_1098(3).jpg',source:'Current uploaded batch; user/location-confirmed destination association'},
{src:'assets/images/073682f2540c4d3a79cf8a8a454dcd83803d0cb429e67bca57be20c464652c02.jpg',filename:'IMG_1108(3).jpg',source:'Current uploaded batch; user/location-confirmed destination association'},
{src:'assets/images/723ddc4db67e5bcd991f54e95ad503d3e0dce954659a9ef1098d9dfa473cd44e.jpg',filename:'IMG_1163(3).jpg',source:'Current uploaded batch; user/location-confirmed destination association'},
]);
PRIMARY_RECOVERED_PHOTOS['Toulouse'] = (PRIMARY_RECOVERED_PHOTOS['Toulouse'] || []).concat([
{src:'assets/images/dfe164e8f7cb46faf274153631b867332ddf113c4e29d2374b959cf0a59732c3.jpg',filename:'WP_20150420_12_48_22_Pro(1).jpg',source:'Current uploaded batch; user/location-confirmed destination association'},
]);

(function attachPrimaryRecoveredPhotos(){
  const norm=x=>String(x||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  for(const d of ALL){
    const match=Object.entries(PRIMARY_RECOVERED_PHOTOS).find(([name])=>norm(name)===norm(d.name));
    if(!match) continue;
    d.photos=Array.isArray(d.photos)?d.photos:[];
    const seen=new Set(d.photos.map(p=>p.src));
    if(d.photo) seen.add(d.photo);
    for(const p of match[1]) if(p.src&&!seen.has(p.src)){d.photos.push({src:p.src,date:d.date||p.date,source:'Primary uploaded photo/metadata recovery'});seen.add(p.src)}
  }
})();
function photoBrowserHtml(){
 if(!activePhotoGallery.length)return '';
 return `<div class="photoBrowser"><div class="photoStage"><button class="pbPrev" onclick="event.stopPropagation();stepDestinationPhoto(-1)" aria-label="Previous destination photo">‹</button><img id="destinationPhotoStage" src="${activePhotoGallery[activePhotoIndex].src}" onclick="openPhotoLightbox(activePhotoIndex)" alt="Travel photo"><button class="pbNext" onclick="event.stopPropagation();stepDestinationPhoto(1)" aria-label="Next destination photo">›</button></div><div id="destinationPhotoCount" class="photoCount">${escHtml(activeDestination?.name||"Destination")} Photos · ${activePhotoIndex+1} of ${activePhotoGallery.length} · tap photo for full view</div><div class="photoStrip">${activePhotoGallery.map((p,i)=>`<img id="destThumb_${i}" class="${i===activePhotoIndex?'active':''}" src="${p.src}" loading="lazy" decoding="async" onclick="setDestinationPhoto(${i})" alt="${escHtml(p.place)}">`).join('')}</div></div>`;
}
function setDestinationPhoto(i){
 if(!activePhotoGallery.length)return;activePhotoIndex=(i+activePhotoGallery.length)%activePhotoGallery.length;
 const img=document.getElementById('destinationPhotoStage');if(img)img.src=activePhotoGallery[activePhotoIndex].src;
 const count=document.getElementById('destinationPhotoCount');if(count)count.textContent=`${escHtml(activeDestination?.name||"Destination")} Photos · ${activePhotoIndex+1} of ${activePhotoGallery.length} · tap photo for full view`;
 document.querySelectorAll('[id^="destThumb_"]').forEach((el,j)=>el.classList.toggle('active',j===activePhotoIndex));
}
function stepDestinationPhoto(n){setDestinationPhoto(activePhotoIndex+n)}
function openPhotoLightbox(index){
  if(!activePhotoGallery.length)return;activePhotoIndex=Math.max(0,Math.min(index,activePhotoGallery.length-1));
  const p=activePhotoGallery[activePhotoIndex];document.getElementById('photoLightboxImg').src=p.src;
  const latitude=Number(p.gps?.[0]),longitude=Number(p.gps?.[1]);
  const hasGps=Number.isFinite(latitude)&&Number.isFinite(longitude)&&Math.abs(latitude)<=90&&Math.abs(longitude)<=180;
  const gps=hasGps
    ?`<div class="note">Photo GPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}</div><a class="streetViewLink" href="https://www.google.com/maps/@?api=1&amp;map_action=pano&amp;viewpoint=${latitude},${longitude}" target="_blank" rel="noopener noreferrer">Open photo location in Street View</a>`
    :'';
  const country=activeDestination?.country||p.country||'';
  const deleteDisabled=photoStoragePath(p.src)?'':' disabled title="Only private family-album photos can be deleted here."';
  const countryAction=country?`<div class="countryPhotoAction"><button type="button" onclick="setCountryDefaultPhoto(${activePhotoIndex})">Set as ${escHtml(country)} default photo</button><button type="button" class="deletePhotoButton" onclick="showPhotoDeleteConfirmation(${activePhotoIndex})"${deleteDisabled}>Delete photo</button><span id="countryPhotoSaveStatus" role="status" aria-live="polite"></span><div id="photoDeleteConfirmation" class="photoDeleteConfirmation" hidden><span>Are you sure? This permanently deletes the photo from the family album.</span><button type="button" onclick="deleteSelectedPhoto(${activePhotoIndex})">Yes</button><button type="button" onclick="cancelPhotoDelete()">Cancel</button></div></div>`:'';
  document.getElementById('photoLightboxMeta').innerHTML=`<b>${escHtml(p.place)}</b> <span class="badge">${activePhotoIndex+1} / ${activePhotoGallery.length}</span><div>${escHtml(p.country||'')}${p.date?' · '+escHtml(p.date):''}</div>${p.trip?`<div class="note">Trip: ${escHtml(p.trip)}</div>`:''}${gps}${countryAction}`;
  document.getElementById('photoLightbox').classList.add('open');
}
function showPhotoDeleteConfirmation(){
  const confirmation=document.getElementById('photoDeleteConfirmation');
  if(confirmation)confirmation.hidden=false;
}
function cancelPhotoDelete(){
  const confirmation=document.getElementById('photoDeleteConfirmation');
  if(confirmation)confirmation.hidden=true;
}
async function deleteSelectedPhoto(index){
  const photo=activePhotoGallery[index],path=photo?photoStoragePath(photo.src):'';
  const status=document.getElementById('countryPhotoSaveStatus');
  const button=document.querySelector('#photoDeleteConfirmation button[onclick^="deleteSelectedPhoto"]');
  if(!path||!photo||!status||!button)return;
  if(!cloudReady||!familyUser){
    status.textContent='Sign in and connect to the family album before deleting photos.';
    return;
  }
  if(!path.startsWith(`${familyUser.id}/`)){
    status.textContent='This photo is not in your family account’s private storage and cannot be deleted here.';
    return;
  }
  const previous=localStateSnapshot();
  button.disabled=true;
  status.textContent='Removing photo references…';
  deletedPhotoPaths.add(path);
  writeLocalState(withoutDeletedPhotoReferences({...previous,deletedPhotoPaths:[...deletedPhotoPaths]}));
  try{
    await flushCloudState();
    status.textContent='Deleting photo from private storage…';
    const {error}=await supabaseClient.storage.from(PHOTO_BUCKET).remove([path]);
    if(error)throw new Error(error.message);
  }catch(error){
    writeLocalState(previous);
    try{
      await flushCloudState();
      status.textContent=`Photo was not deleted. Changes were restored. ${error.message}`;
    }catch(rollbackError){
      status.textContent=`Deletion failed (${error.message}), and restoring the album state also failed (${rollbackError.message}). Reload and check the family album before trying again.`;
    }
    button.disabled=false;
    return;
  }
  signedPhotoUrls.delete(path);
  closePhotoLightbox();
  rebuildMaster();
  const old=activeDestination;
  const updated=old?ALL.find(record=>record._baseId===old._baseId&&old._baseId)
    ||findPlaceKey(old.name,old.country,old.year):null;
  if(updated)renderDestinationCard(updated);
}
async function setCountryDefaultPhoto(index){
  const photo=activePhotoGallery[index],country=String(activeDestination?.country||photo?.country||'').trim();
  const status=document.getElementById('countryPhotoSaveStatus');
  const button=document.querySelector('.countryPhotoAction button');
  if(!photo?.src||!country||!status||!button)return;
  button.disabled=true;
  status.textContent='Saving…';
  try{
    registerCountry(country);
    const registry=loadCountryRegistry();
    const entry=registry.find(item=>normCountry(item.name)===normCountry(country));
    if(!entry)throw new Error(`Could not find ${country} in the country registry.`);
    entry.defaultPhoto=countryDefaultPhotoReference(photo);
    saveCountryRegistry(registry);
    if(!cloudReady||!familyUser)throw new Error('The family album is not connected.');
    await flushCloudState();
    status.textContent=`Saved as the default photo for ${country}.`;
  }catch(error){
    status.textContent=`Saved on this device, but cloud sync failed: ${error.message}`;
  }finally{
    button.disabled=false;
  }
}
function closePhotoLightbox(){document.getElementById('photoLightbox').classList.remove('open')}
function stepPhoto(n){if(!activePhotoGallery.length)return;activePhotoIndex=(activePhotoIndex+n+activePhotoGallery.length)%activePhotoGallery.length;openPhotoLightbox(activePhotoIndex)}
document.addEventListener('keydown',e=>{if(!document.getElementById('photoLightbox')?.classList.contains('open'))return;if(e.key==='Escape')closePhotoLightbox();if(e.key==='ArrowLeft')stepPhoto(-1);if(e.key==='ArrowRight')stepPhoto(1)});
function showMapInfo(d){
  const card=document.getElementById('mapInfoCard'); if(!card)return;
  const trip=tripForDestination(d);
  const tripName=trip?trip.name:(d.note||d.name);
  const tripDate=trip?trip.date:(d.date||'Date being reconciled');
  activePhotoGallery=getRelatedPhotos(d);
  const hasPhoto=activePhotoGallery.length>0;
  const status=hasPhoto
    ? `<div class="infostatus"><strong>${activePhotoGallery.length} ${escHtml(d.name)} photo${activePhotoGallery.length===1?'':'s'} available</strong> — only photos assigned to this destination appear here.</div>`
    : '<div class="infostatus"><strong>Information only</strong> — no connected photo is currently available for this destination.</div>';
  const gallery=hasPhoto?`<div class="photoGallery">${activePhotoGallery.map((p,i)=>`<div class="photoThumb" onclick="openPhotoLightbox(${i})" title="Open photo"><img src="${p.src}" loading="lazy" decoding="async" alt="Travel photo — ${escHtml(p.place)}"><div class="photoPlace">${escHtml(p.place)}</div></div>`).join('')}</div><div class="galleryHint">Click or tap any photo to open it full-size. Full view includes location, date and trip information.</div>`:'';
  const addPhoto=`<button onclick="editPlaceByKey('${escJs(d.name)}','${escJs(d.country)}',${JSON.stringify(d.year||'')});setTimeout(()=>document.getElementById('editPhoto')?.click(),160)">＋ Add Photos</button>`;
  const edit=`<button onclick="editPlaceByKey('${escJs(d.name)}','${escJs(d.country)}',${JSON.stringify(d.year||'')})">✎ Edit Trip</button>`;
  card.innerHTML=`<button class="panelx" aria-label="Close trip information" onclick="document.getElementById('mapInfoCard').style.display='none'">×</button><h3 style="margin:0 28px 4px 0">${d.name}</h3><div class="tripline">${tripName}</div><div>${tripDate}</div><div class="note" style="margin-top:6px">${d.country}${d.note?' • '+d.note:''}</div>${gallery}${status}<div class="cardactions">${!hasPhoto?addPhoto:''}${edit}</div>`;
  card.style.display='block';
}

// ===== RECONSTRUCTED MASTER: PHOTO / MAP INTEGRITY LAYER =====
// Never borrow sibling-trip/country photos for a destination card.
// These are places Ginny already established as having photo evidence, even if the
// actual image blob was lost from a later HTML build. We show that truth rather than
// substituting an unrelated image.
const KNOWN_PHOTO_EVIDENCE = new Map([
  ['lisbon|portugal','Photos confirmed in the project audit; Ben\'s Lisbon visit is 2023. Correct image association is being recovered.'],
  ['belize|belize','Photos confirmed by Ginny; existing archive needs destination reassociation.'],
  ['guatemala|guatemala','Photos confirmed by Ginny from Ben\'s trip.'],
  ['haifa|israel','Destination confirmed by Ginny; exact photo association remains to be linked.'],
  ['eilat|israel','Eilat / Red Sea confirmed by Ginny; exact photo association remains to be linked.'],
  ['manila|philippines','2026 photos were previously supplied; image association must be recovered, not replaced.'],
  ['el nido|philippines','2026 Palawan / El Nido photos were previously supplied; image association must be recovered, not replaced.'],
  ['taiwan|taiwan','2026 Taiwan photos were previously supplied; exact destination association is being reconciled.']
]);
function photoEvidenceKey(d){return `${String(d?.name||'').trim().toLowerCase()}|${String(d?.country||'').trim().toLowerCase()}`}
function destinationPhotos(d){ return getRelatedPhotos(d); }
// Strict, exact-destination-only photo resolver. No trip-wide fallback is permitted.
function strictDestinationPhotos(d){
  const out=[], seen=new Set();
  const add=(src,p={})=>{
    if(!src||deletedPhotoPaths.has(photoStoragePath(src)))return;
    const identity=photoStoragePath(src)||src;
    const latitude=Number(p.gps?.[0]),longitude=Number(p.gps?.[1]);
    const gps=Number.isFinite(latitude)&&Number.isFinite(longitude)&&Math.abs(latitude)<=90&&Math.abs(longitude)<=180
      ?[latitude,longitude]:null;
    if(seen.has(identity)){
      const existing=out.find(photo=>(photoStoragePath(photo.src)||photo.src)===identity);
      if(existing&&!existing.gps&&gps)existing.gps=gps;
      return;
    }
    seen.add(identity);
    out.push({src,place:d.name,country:d.country,date:p.date||d.date||'',trip:(tripForDestination(d)?.name||d.note||d.name),gps});
  };
  (Array.isArray(d.photos)?d.photos:[]).forEach(p=>add(p?.src,p||{}));
  add(d.photo||'',d.photoMetadata||{});
  if(d.addedTripId){ const t=loadAddedTrips().find(x=>x.id===d.addedTripId); (t?.photos||[]).forEach(p=>add(p.data,{date:p.date||d.date,gps:p.gps})); }
  // Exact duplicate destination records only; never same-country or same-trip siblings.
  ALL.filter(x=>x!==d && String(x.name||'').trim().toLowerCase()===String(d.name||'').trim().toLowerCase() && String(x.country||'').trim().toLowerCase()===String(d.country||'').trim().toLowerCase())
     .forEach(x=>{ (Array.isArray(x.photos)?x.photos:[]).forEach(p=>add(p?.src,p||{})); add(x.photo||'',x.photoMetadata||{date:x.date}); });
  const preferred=countryDefaultPhoto(d.country,out);
  const preferredIndex=preferred?out.indexOf(preferred):-1;
  if(preferredIndex>0)out.unshift(out.splice(preferredIndex,1)[0]);
  return out;
}
getRelatedPhotos = strictDestinationPhotos;
function firstUploadedPhotoForCountry(country){
  for(const trip of loadAddedTrips()){
    if(normCountry(trip.country)!==normCountry(country))continue;
    const photo=(trip.photos||[]).find(item=>item?.data||item?.src);
    if(photo)return {src:photo.data||photo.src};
  }
  return photosForCountry(country)[0]||null;
}
function pickPhotoThumbnail(photos,fallback=null){
  const candidates=photos.filter(photo=>photo?.src);
  if(!candidates.length)return null;
  return candidates[Math.floor(Math.random()*candidates.length)]||fallback||candidates[0];
}
function photosForCountry(country){
  const photos=[],seen=new Set();
  const add=src=>{
    if(src&&!deletedPhotoPaths.has(photoStoragePath(src))&&!seen.has(src)){seen.add(src);photos.push({src})}
  };
  ALL.filter(destination=>normCountry(destination.country)===normCountry(country)).forEach(destination=>{
    (destination.photos||[]).forEach(photo=>add(photo?.src));
    add(destination.photo);
    if(destination.addedTripId){
      const trip=loadAddedTrips().find(item=>item.id===destination.addedTripId);
      (trip?.photos||[]).forEach(photo=>add(photo.data||photo.src));
    }
  });
  loadAddedTrips().filter(trip=>normCountry(trip.country)===normCountry(country))
    .forEach(trip=>(trip.photos||[]).forEach(photo=>add(photo.data||photo.src)));
  return photos;
}
function countryDefaultPhotoReference(photo){
  const path=photoStoragePath(photo.src);
  return path?storageReference(path):photo.src;
}
function countryDefaultPhoto(country,photos=photosForCountry(country)){
  const saved=loadCountryRegistry().find(item=>normCountry(item.name)===normCountry(country))?.defaultPhoto;
  if(!saved)return null;
  const savedPath=photoStoragePath(saved);
  return photos.find(photo=>{
    if(photo.src===saved)return true;
    if(savedPath)return photoStoragePath(photo.src)===savedPath;
    return false;
  })||null;
}
function countryPhotoThumbnailHtml(country){
  const photos=photosForCountry(country);
  const photo=countryDefaultPhoto(country,photos)||pickPhotoThumbnail(photos,firstUploadedPhotoForCountry(country));
  return photo?`<img class="photoRowThumbnail" src="${escHtml(photo.src)}" alt="" loading="lazy" decoding="async">`:'';
}
function tripPhotoThumbnailHtml(trip){
  const photos=[];
  (trip.photos||[]).forEach(photo=>{const src=photo?.data||photo?.src;if(src&&!deletedPhotoPaths.has(photoStoragePath(src)))photos.push({src})});
  (trip.destinations||[]).forEach(name=>{
    const destination=ALL.find(record=>record.name===name);
    if(destination)getRelatedPhotos(destination).forEach(photo=>photos.push(photo));
  });
  const countryPhotos=trip.country?photosForCountry(trip.country):[];
  const firstUploaded=trip.country?firstUploadedPhotoForCountry(trip.country):null;
  const photo=pickPhotoThumbnail(photos,firstUploaded)||pickPhotoThumbnail(countryPhotos,firstUploaded);
  return photo?`<img class="photoRowThumbnail" src="${escHtml(photo.src)}" alt="" loading="lazy" decoding="async">`:'';
}
function knownPhotoEvidence(d){
  const direct=KNOWN_PHOTO_EVIDENCE.get(photoEvidenceKey(d));
  if(direct)return direct;
  if(d?.photoAudit?.pendingImageIntegration)return `${d.photoAudit.files?.length||'Known'} audited destination photo record(s) identified; image connection pending.`;
  return '';
}

function renderDestinationCard(d){
  if(!d)return;activeDestination=d;closeMobileMenu();if(globe) globe.controls().autoRotate=false;
  const trip=tripForDestination(d);
  const tripName=trip?.name||d.note||d.name;
  const tripDate=trip?.date||d.date||String(d.year||'Date not added yet');
  activePhotoGallery=getRelatedPhotos(d);activePhotoIndex=0;
  const hasPhoto=activePhotoGallery.length>0;
  document.getElementById('place').textContent=d.name;
  document.getElementById('date').textContent=tripDate;
  const browser=hasPhoto?photoBrowserHtml():'';
  const knownEvidence=knownPhotoEvidence(d); const status=hasPhoto?`<div class="infostatus"><strong>${activePhotoGallery.length} ${escHtml(d.name)} photo${activePhotoGallery.length===1?'':'s'} available</strong> — only photos assigned to this exact destination appear here.</div>`:(knownEvidence?`<div class="infostatus"><strong>Photo evidence exists — image connection pending</strong><br>${escHtml(knownEvidence)}<br><em>No unrelated trip photo will be substituted.</em></div>`:'<div class="infostatus"><strong>Information only</strong> — no connected destination photo is currently available.</div>');
  const addPhoto=`<button onclick="editPlaceByKey('${escJs(d.name)}','${escJs(d.country)}',${JSON.stringify(d.year||'')})">＋ Add Photos</button>`;
  const edit=`<button onclick="editPlaceByKey('${escJs(d.name)}','${escJs(d.country)}',${JSON.stringify(d.year||'')})">✎ Edit Trip</button>`;
  const explore=(Number.isFinite(d.lat)&&Number.isFinite(d.lng))?`<button class="primaryAction" onclick="openActiveDestinationMap()">🗺 Open Detailed Street Map</button>`:'';
  document.getElementById('note').innerHTML=`<div class="note" style="margin-bottom:7px"><b>${escHtml(tripName)}</b><br>${escHtml(d.country)}${d.note?' • '+escHtml(d.note):''}</div>${browser}${status}<div class="cardactions">${explore}${addPhoto}${edit}</div>${explore?`<div class="mapHint">Street-level detail opens in the larger 2-D map; use Back to Globe to return.</div>`:""}`;
  document.getElementById('panel').style.display='block';
  document.getElementById('panel').scrollTop=0;
}

function openActiveDestinationMap(){
  const d=activeDestination;
  if(!d||!Number.isFinite(d.lat)||!Number.isFinite(d.lng))return;
  const photo=activePhotoGallery[activePhotoIndex];
  const photoLat=Number(photo?.gps?.[0]),photoLng=Number(photo?.gps?.[1]);
  const hasPhotoGps=Number.isFinite(photoLat)&&Number.isFinite(photoLng)&&Math.abs(photoLat)<=90&&Math.abs(photoLng)<=180;
  openDetailedMap(d,hasPhotoGps?[photoLat,photoLng]:[d.lat,d.lng]);
}
function exploreMap(name,country,year){
  const d=findPlaceKey(name,country,year);
  if(d) openDetailedMap(d);
}
function openDetailedMap(d,coordinates=[d.lat,d.lng]){
  const [latitude,longitude]=coordinates;
  activeDestination=d;
  if(globe) globe.controls().autoRotate=false;
  const stage=document.getElementById('detailMapStage');
  const panel=document.getElementById('panel');
  if(panel) panel.style.display='none';
  document.getElementById('mapTitle').textContent=d.name+' — detailed street map';
  stage.style.display='block';
  showMapInfo(d);
  setTimeout(()=>{
    try{
      if(typeof L==='undefined') throw new Error('Detailed map library did not load');
      if(!map){
        map=L.map('detailMap',{zoomControl:true,touchZoom:true,scrollWheelZoom:true,doubleClickZoom:true,dragging:true}).setView([latitude,longitude],14);
        const streets=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Tiles © Esri'});
        streets.addTo(map);
      }else{
        map.setView([latitude,longitude],14,{animate:false});
      }
      if(marker) marker.remove();
      marker=L.marker([latitude,longitude]).addTo(map).bindPopup(d.name).openPopup();
      map.invalidateSize(true);
      setTimeout(()=>map.invalidateSize(true),300);
    }catch(err){
      document.getElementById('detailMap').innerHTML='<div style="height:100%;display:grid;place-items:center;padding:28px;text-align:center;color:#07111e;background:#e7eef3"><div><b>Detailed map could not load.</b><br><small>Please make sure this page has internet access, then reopen the map.</small></div></div>';
    }
  },120);
}
function openPlace(d){renderDestinationCard(d)}
function backToGlobe(){document.getElementById('detailMapStage').style.display='none';document.getElementById('mapInfoCard').style.display='none';if(globe)globe.controls().autoRotate=false;if(activeDestination)renderDestinationCard(activeDestination)}
function renderList(){const box=document.getElementById('destList');box.innerHTML=current.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(d=>`<div class="listitem" data-name="${d.name.replaceAll('"','&quot;')}">📍 ${d.name} <span class="badge">${d.country}</span></div>`).join('');box.querySelectorAll('.listitem').forEach(el=>el.onclick=()=>{const d=current.find(d=>d.name===el.dataset.name); if(d)openPlace(d)})}
function toggleList(){const x=document.getElementById('destList');x.style.display=x.style.display==='none'?'block':'none';renderList()} function toggleStats(){const p=document.getElementById('panel');p.style.display=p.style.display==='none'?'block':'none'} function closeStats(){document.getElementById('panel').style.display='none'} function toggleMobileMenu(){const t=document.getElementById('mainToolbar');t.classList.toggle('mobileOpen');document.getElementById('mobileMenuBtn').setAttribute('aria-expanded',t.classList.contains('mobileOpen')?'true':'false')} function closeMobileMenu(){document.getElementById('mainToolbar').classList.remove('mobileOpen');document.getElementById('mobileMenuBtn')?.setAttribute('aria-expanded','false')}
const BASE_ALL=[...ALL].map((d,i)=>({...d,_baseId:'base_'+i}));
function loadOverrides(){try{return JSON.parse(localStorage.getItem(OVERRIDE_KEY)||'{}')}catch(e){return {}}}
function persistOverrides(v){localStorage.setItem(OVERRIDE_KEY,JSON.stringify(v));queueCloudSave()}
function loadAddedTrips(){try{return JSON.parse(localStorage.getItem(TRIP_KEY)||'[]')}catch(e){return []}}
function persistTrips(v){localStorage.setItem(TRIP_KEY,JSON.stringify(v));queueCloudSave()}
function openAddTrip(){closeMobileMenu();document.getElementById('addTripBack').style.display='flex';document.getElementById('tripMsg').textContent=''}
function closeAddTrip(){document.getElementById('addTripBack').style.display='none'}
function previewTripPhotos(){const box=document.getElementById('tripPhotoPreview');box.innerHTML='';[...document.getElementById('tripPhotos').files].slice(0,8).forEach(f=>{const im=document.createElement('img');im.src=URL.createObjectURL(f);box.appendChild(im)})}
function titleCaseCountry(s){return (s||'').trim()}
async function geocodePlace(q){
  if(!q) return null;
  try{
    const u='https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q='+encodeURIComponent(q);
    const r=await fetch(u,{headers:{'Accept':'application/json'}}); if(!r.ok) return null;
    const a=await r.json(); if(!a.length) return null; const g=a[0], ad=g.address||{};
    return {lat:+g.lat,lng:+g.lon,country:titleCaseCountry(ad.country||''),city:ad.city||ad.town||ad.village||ad.municipality||ad.county||q.split(',')[0].trim(),display:g.display_name};
  }catch(e){return null}
}
function tripToDestination(t){
  if(!t.place) return null;
  // A trip can contribute to the living country/destination data even before exact coordinates are known.
  // Only geographically resolved records become globe pushpins.
  if(!Number.isFinite(t.lat) || !Number.isFinite(t.lng)) return {name:t.city||t.place.split(',')[0].trim()||t.name,country:t.country||countryFromPlace(t.place)||'Location to confirm',lat:null,lng:null,year:yearFromDate(t.start),date:t.start?formatFlexibleDate(t.start):'Date not added yet',note:t.name,photo:t.photos?.[0]?.data||'',addedTripId:t.id,status:'needs-location'};
  const y=yearFromDate(t.start);
  const date=t.start?(t.end&&t.end!==t.start?formatFlexibleDate(t.start)+' → '+formatFlexibleDate(t.end):formatFlexibleDate(t.start)):(y?String(y):'Date not added yet');
  return {name:t.city||t.place.split(',')[0].trim()||t.name,country:t.country||'Location to confirm',lat:t.lat,lng:t.lng,year:y,date,note:(t.name+(t.notes?' • '+t.notes:'')),photo:t.photos?.[0]?.data||'',addedTripId:t.id,status:'user-added'};
}
function rebuildMaster(){
  const ov=loadOverrides();
  const base=BASE_ALL.map(d=>{
    const record=withoutDeletedPhotoReferences({...d,...(ov[d._baseId]||{})});
    delete record.heroStatus;
    delete record.heroSource;
    delete record.benVisibleEstablished;
    return record;
  }).filter(d=>!d._deleted);
  const added=loadAddedTrips().map(tripToDestination).filter(Boolean);
  ALL=[...base,...added]; current=[...ALL];
  refreshYearUI(); updateNums(); renderList(); if(globe){const mappable=current.filter(d=>Number.isFinite(d.lat)&&Number.isFinite(d.lng));globe.pointsData(mappable);}
}
function refreshYearUI(){
  const ys=knownYears(ALL), s=document.getElementById('yearSelect'), prior=s.value||'all';
  s.innerHTML='<option value="all">Travel by year</option>'; ys.forEach(y=>{let o=document.createElement('option');o.value=y;o.textContent=y;s.appendChild(o)}); if([...s.options].some(o=>o.value===prior))s.value=prior;
  const b=document.getElementById('yearBtns'); b.innerHTML=''; ys.forEach(y=>{let x=document.createElement('button');x.textContent=y;x.onclick=()=>{s.value=String(y);filterYear(y)};b.appendChild(x)});
}
function normalizeDateInput(v){
  v=String(v||'').trim(); if(!v)return '';
  if(/^\d{4}$/.test(v)) return v;
  let m=v.match(/^(0?[1-9]|1[0-2])\/(\d{4})$/); if(m)return m[2]+'-'+String(m[1]).padStart(2,'0');
  m=v.match(/^(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(\d{2}|\d{4})$/);
  if(m){let y=m[3]; if(y.length===2)y=(Number(y)>=70?'19':'20')+y; return y+'-'+String(m[1]).padStart(2,'0')+'-'+String(m[2]).padStart(2,'0')}
  if(/^\d{4}-\d{2}(-\d{2})?$/.test(v))return v; // backward compatibility with earlier saved entries
  return null;
}
function validFlexibleDate(v){return normalizeDateInput(v)!==null}
function yearFromDate(v){const n=normalizeDateInput(v);return n?Number(n.slice(0,4)):0}
function formatFlexibleDate(v){const n=normalizeDateInput(v);if(!n)return ''; const p=n.split('-'); if(p.length===1)return p[0]; if(p.length===2)return String(Number(p[1])).padStart(2,'0')+'/'+p[0]; const yy=p[0].slice(-2);return String(Number(p[1])).padStart(2,'0')+'/'+String(Number(p[2])).padStart(2,'0')+'/'+yy}
function editDisplayDate(v){return formatFlexibleDate(v)}
function countryFromPlace(place){
  if(!place)return '';
  const parts=place.split(',').map(x=>x.trim()).filter(Boolean);
  // If the user supplied Country or City, Country, preserve the final country-like component.
  // A single-word entry such as Guatemala is treated as a country/territory pending geolocation.
  return parts.length>1?parts[parts.length-1]:(parts.length===1 && !/\s/.test(parts[0])?parts[0]:'');
}
async function saveTrip(continueEditing=false){
  const name=document.getElementById('tripName').value.trim(); if(!name){document.getElementById('tripMsg').textContent='Please add a trip name.';return}
  let start=document.getElementById('tripStart').value, end=document.getElementById('tripEnd').value; const place=document.getElementById('tripPlace').value.trim(), notes=document.getElementById('tripNotes').value.trim();
  if(!validFlexibleDate(start)||!validFlexibleDate(end)){document.getElementById('tripMsg').textContent='Use MM/DD/YY, MM/YYYY, or YYYY.';return}
  start=normalizeDateInput(start); end=normalizeDateInput(end);
  if(start&&end&&end<start){document.getElementById('tripMsg').textContent='End date cannot be before start date.';return}
  const msg=document.getElementById('tripMsg'); msg.textContent=place?'Locating destination and integrating trip…':'Saving trip…';
  const files=[...document.getElementById('tripPhotos').files];
  let photos=[];
  try{
    for(const file of files.slice(0,12)){
      msg.textContent=`Preparing photo ${photos.length+1} of ${Math.min(files.length,12)}…`;
      photos.push(await processAndUploadPhoto(file));
    }
  }catch(error){
    msg.textContent=error.message;
    return;
  }
  let geo=place?await geocodePlace(place):null;
  const trip={id:'trip_'+Date.now(),name,start,end,place,notes,photos,year:yearFromDate(start),status:place?(geo?'integrated':'needs-location'):'incomplete',created:new Date().toISOString(),lat:geo?.lat??null,lng:geo?.lng??null,country:geo?.country||countryFromPlace(place),city:geo?.city||(place?place.split(',')[0].trim():''),display:geo?.display||place}; if(trip.country)registerCountry(trip.country);
  const saved=loadAddedTrips(); saved.push(trip);
  persistTrips(saved);
  rebuildMaster(); renderAddedTrips();
  try{await flushCloudState()}
  catch(error){msg.textContent=`Trip saved on this device, but cloud sync failed: ${error.message}`;return}
  if(!place) msg.textContent='Trip saved. Add a destination later to create its pushpin and update travel totals.';
  else if(!geo) msg.textContent='Trip saved. Country/destination data were updated where possible; the pushpin is waiting for location confirmation.';
  else msg.textContent='Integrated: pushpin, destination, country and year statistics updated.';
  if(continueEditing){
    msg.textContent=(msg.textContent||'Trip saved.')+' You can keep editing or add another trip.';
  }else{
    setTimeout(()=>{closeAddTrip();clearTripForm()},350);
  }
}
function clearTripForm(){['tripName','tripStart','tripEnd','tripPlace','tripNotes'].forEach(id=>document.getElementById(id).value='');document.getElementById('tripPhotos').value='';document.getElementById('tripPhotoPreview').innerHTML=''}
function renderAddedTrips(){
  // Intentionally no permanent on-screen list. Recent additions live in their own pop-up.
  const old=document.getElementById('addedTrips'); if(old) old.remove();
}
function recentTrips(){
  const cutoff=Date.now()-183*24*60*60*1000;
  return loadAddedTrips().filter(t=>{const x=Date.parse(t.created||'');return Number.isFinite(x)&&x>=cutoff}).sort((a,b)=>Date.parse(b.created)-Date.parse(a.created));
}
function openRecentTrips(){closeMobileMenu();
  const list=recentTrips(), box=document.getElementById('recentTripsList');
  box.innerHTML=list.length?list.map(t=>`<div class="listitem photoRow"><span class="photoRowContent">${tripPhotoThumbnailHtml(t)}<span>✈️ <b>${escHtml(t.name)}</b></span> <span class="badge">${t.start?((t.end&&t.end!==t.start)?formatFlexibleDate(t.start)+' → '+formatFlexibleDate(t.end):formatFlexibleDate(t.start)):'dates later'}</span>${t.country?` <span class="badge">${escHtml(t.country)}</span>`:''}${t.photos?.length?` <span class="badge">${t.photos.length} photo${t.photos.length===1?'':'s'}</span>`:''} <span class="badge">${t.status==='integrated'?'✓ integrated':t.status==='needs-location'?'needs location':'finish later'}</span></span><button style="margin-left:auto" onclick="editRecentTrip('${escJs(t.id)}')">✎ Edit</button></div>`).join(''):'<div class="note">No trips have been added in the past six months.</div>';
  document.getElementById('recentBack').style.display='flex';
}
function closeRecentTrips(){document.getElementById('recentBack').style.display='none'}
let editReturnToRecent=false;
function editRecentTrip(id){
  editReturnToRecent=true;
  closeRecentTrips();
  openEditRecords();
  const sel=document.getElementById('editRecord');
  const idx=[...sel.options].findIndex(o=>o.value===id && o.dataset.kind==='trip');
  if(idx>=0){sel.selectedIndex=idx;loadEditRecord();}
}

function openEditRecords(){closeMobileMenu();
  const sel=document.getElementById('editRecord'); sel.innerHTML='';
  const ov=loadOverrides();
  BASE_ALL.map(d=>({...d,...(ov[d._baseId]||{})})).filter(d=>!d._deleted).sort((a,b)=>a.name.localeCompare(b.name)).forEach(d=>{const o=document.createElement('option');o.value=d._baseId;o.textContent='📍 '+d.name+' — '+d.country;o.dataset.kind='base';sel.appendChild(o)});
  loadAddedTrips().forEach(t=>{const o=document.createElement('option');o.value=t.id;o.textContent='✈️ '+t.name+(t.country?' — '+t.country:'');o.dataset.kind='trip';sel.appendChild(o)});
  document.getElementById('editBack').style.display='flex'; document.getElementById('editMsg').textContent=''; loadEditRecord();
}
function closeEditRecords(){document.getElementById('editBack').style.display='none'; if(editReturnToRecent){editReturnToRecent=false;setTimeout(openRecentTrips,80)}}
function selectedEdit(){const sel=document.getElementById('editRecord'),opt=sel.options[sel.selectedIndex];return opt?{id:opt.value,kind:opt.dataset.kind}:null}
function loadEditRecord(){
  const x=selectedEdit(); if(!x)return;
  if(x.kind==='trip'){
    const t=loadAddedTrips().find(z=>z.id===x.id); if(!t)return;
    editName.value=t.name||''; editStart.value=editDisplayDate(t.start)||''; editEnd.value=editDisplayDate(t.end)||''; editPlace.value=t.place||t.display||''; editCountry.value=t.country||''; editNotes.value=t.notes||'';
  } else {
    const ov=loadOverrides(), b=BASE_ALL.find(z=>z._baseId===x.id), d={...b,...(ov[x.id]||{})}; if(!d)return;
    editName.value=d.name||''; editStart.value=editDisplayDate(d.rawStart)||String(d.year||''); editEnd.value=editDisplayDate(d.rawEnd)||''; editPlace.value=d.editPlace||((d.name||'')+', '+(d.country||'')); editCountry.value=d.country||''; editNotes.value=d.note||'';
  }
  editPhoto.value=''; editMsg.textContent='';
}
async function saveRecordEdit(){
  const x=selectedEdit(); if(!x)return; const name=editName.value.trim(), place=editPlace.value.trim(), country=editCountry.value.trim(), notes=editNotes.value.trim(); let start=editStart.value.trim(), end=editEnd.value.trim();
  if(!name){editMsg.textContent='Please keep a name for this record.';return}
  if(!validFlexibleDate(start)||!validFlexibleDate(end)){editMsg.textContent='Use MM/DD/YY, MM/YYYY, or YYYY.';return}
  const nStart=normalizeDateInput(start), nEnd=normalizeDateInput(end); start=nStart; end=nEnd;
  if(start&&end&&end<start){editMsg.textContent='End date cannot be before start date.';return}
  editMsg.textContent='Saving changes…';
  let photo=null;
  const file=editPhoto.files[0];
  if(file){
    try{photo=await processAndUploadPhoto(file)}
    catch(error){editMsg.textContent=error.message;return}
  }
  if(x.kind==='trip'){
    const a=loadAddedTrips(), i=a.findIndex(z=>z.id===x.id); if(i<0)return; let t=a[i], geo=null;
    if(place && place!==t.place) geo=await geocodePlace(place);
    t={...t,name,start,end,place,country:country||(geo?.country)||countryFromPlace(place)||t.country,notes,year:yearFromDate(start)}; if(t.country)registerCountry(t.country);
    if(geo){t.lat=geo.lat;t.lng=geo.lng;t.city=geo.city;t.display=geo.display;t.status='integrated'} else if(place && !Number.isFinite(t.lat)){t.status='needs-location'}
    if(photo){t.photos=t.photos||[];t.photos.push(photo)} a[i]=t; persistTrips(a);
  } else {
    const b=BASE_ALL.find(z=>z._baseId===x.id), ov=loadOverrides(), prior=ov[x.id]||{}; let geo=null;
    const originalPlace=(b.name||'')+', '+(b.country||''); if(place && place!==originalPlace && place!==prior.editPlace) geo=await geocodePlace(place);
    const patch={...prior,name,country:country||geo?.country||b.country,note:notes,rawStart:start,rawEnd:end,year:start?yearFromDate(start):(prior.year??b.year),date:start?(end&&end!==start?formatFlexibleDate(start)+' → '+formatFlexibleDate(end):formatFlexibleDate(start)):(prior.date??b.date),editPlace:place}; if(patch.country)registerCountry(patch.country);
    if(geo){patch.lat=geo.lat;patch.lng=geo.lng}
    if(photo){
      patch.photos=[...(prior.photos||b.photos||[]),{src:photo.data,name:photo.name,date:photo.date,gps:photo.gps,storagePath:photo.storagePath}];
    }
    ov[x.id]=patch; persistOverrides(ov);
  }
  rebuildMaster(); renderAddedTrips(); editMsg.textContent='Saving changes to the family album…';
  try{await flushCloudState();editMsg.textContent='Saved and synced across devices.';setTimeout(()=>{closeEditRecords()},900)}
  catch(error){editMsg.textContent=`Saved on this device, but cloud sync failed: ${error.message}`}
}

function deleteSelectedRecord(){
  const x=selectedEdit(); if(!x)return;
  const label=document.getElementById('editName').value.trim()||'this record';
  if(!confirm('Delete '+label+'? This will recalculate countries, destinations, years and pushpins.'))return;
  if(x.kind==='trip'){
    persistTrips(loadAddedTrips().filter(t=>t.id!==x.id));
  }else{
    // Base records are not destroyed; deletion is stored as an explicit user deletion so it can be audited.
    const ov=loadOverrides(); ov[x.id]={...(ov[x.id]||{}),_deleted:true}; persistOverrides(ov);
  }
  rebuildMaster(); closeEditRecords();
}

;

/* EDIT 7.1 REPAIR BUILD — single-route navigation + derived annual country counts.
   This intentionally leaves unresolved photo files marked as known supplied rather than inventing images. */
(function(){
 const repairRecords=[
  {name:'Jaffa',country:'Israel',lat:32.0549,lng:34.7522,year:'2009–10',visitYears:[2009,2010],date:'Late Dec 2009–early Jan 2010',note:'Israel trip · photo evidence confirmed by Ginny',photoAudit:{status:'confirmed'}},
  {name:'Tel Aviv',country:'Israel',lat:32.0853,lng:34.7818,year:'2009–10',visitYears:[2009,2010],date:'Late Dec 2009–early Jan 2010',note:'Israel trip · skyline photo confirmed by Ginny',photoAudit:{status:'confirmed'}},
  {name:'Sea of Galilee',country:'Israel',lat:32.8244,lng:35.5879,year:2010,visitYears:[2010],date:'Jan 2, 2010',note:'Photo and date confirmed by Ginny',photoAudit:{status:'confirmed'}},
  {name:'Haifa',country:'Israel',lat:32.7940,lng:34.9896,year:'2009–10',visitYears:[2009,2010],date:'Late Dec 2009–early Jan 2010',note:'Visit confirmed · exact photo association pending'},
  {name:'Eilat / Red Sea',country:'Israel',lat:29.5577,lng:34.9519,year:'2009–10',visitYears:[2009,2010],date:'Late Dec 2009–early Jan 2010',note:'Visit confirmed · exact photo association pending'},
  {name:'Lake Bled',country:'Slovenia',lat:46.3683,lng:14.1146,year:2016,visitYears:[2016],date:'Jul 2016',note:'2016 Europe trip'},
  {name:'Queensland',country:'Australia',lat:-20.9176,lng:142.7028,year:2019,visitYears:[2019],date:'2019',note:'Destination confirmed · exact photo association pending'},
  {name:'Manila',country:'Philippines',lat:14.5995,lng:120.9842,year:2026,visitYears:[2026],date:'2026',note:'2026 Philippines trip · photos previously supplied; reassociation pending',photoAudit:{status:'known-supplied'}},
  {name:'El Nido / Palawan',country:'Philippines',lat:11.1956,lng:119.4075,year:2026,visitYears:[2026],date:'2026',note:'2026 Philippines trip · photos previously supplied; reassociation pending',photoAudit:{status:'known-supplied'}},
  {name:'Hong Kong',country:'Hong Kong',lat:22.3193,lng:114.1694,year:2026,visitYears:[2026],date:'2026',note:'2026 trip · destination recovered from master data'},
  {name:'Taiwan — 2026 visit',country:'Taiwan',lat:null,lng:null,year:2026,visitYears:[2026],date:'2026',note:'2026 Taiwan visit confirmed by Ginny · photos previously supplied; exact destination/photo reassociation pending',photoAudit:{status:'known-supplied'}}
 ];
 function yearsOf(d){ if(Array.isArray(d.visitYears)&&d.visitYears.length)return d.visitYears.map(Number); if(String(d.year)==='2009–10')return [2009,2010]; const y=Number(d.year); return Number.isFinite(y)&&y>0?[y]:[]; }
 ALL.forEach(d=>{ if(!d.visitYears)d.visitYears=yearsOf(d); });
 repairRecords.forEach(r=>{ const existing=ALL.find(d=>d.name===r.name&&normCountry(d.country)===normCountry(r.country)); if(existing)Object.assign(existing,r); else ALL.push(r); });
 // Authoritative user corrections / audit updates.
 const jer=ALL.find(d=>d.name==='Jerusalem'); if(jer){jer.year='2009–10';jer.visitYears=[2009,2010];jer.date='Late Dec 2009–early Jan 2010';jer.note='Israel trip · Ben visible in photo confirmed by Ginny';}
 const oax=ALL.find(d=>d.name==='Oaxaca City'); if(oax){oax.year=2008;oax.visitYears=[2008];oax.note=(oax.note||'')+' · six Oaxaca City photos confirmed by Ginny';}
 const uru=ALL.find(d=>d.name==='Centro Cultural Bastión del Carmen'); if(uru){uru.visitYears=[2008];}
 // Never resurrect explicit corrections.
 ALL=ALL.filter(d=>!String(d.name||'').toLowerCase().includes('moloka'));
 current=[...ALL];
 window.yearsOf=yearsOf;
 window.destinationsForYear=function(y){return ALL.filter(d=>yearsOf(d).includes(Number(y)))};
 window.countriesForYear=function(y){return uniq(destinationsForYear(y).map(d=>d.country).filter(Boolean).map(c=>c.trim())).sort((a,b)=>a.localeCompare(b));};
 window.canonicalYears=function(){const ys=new Set();ALL.forEach(d=>yearsOf(d).forEach(y=>ys.add(y)));loadAddedTrips().forEach(t=>{[t.start,t.end].forEach(v=>{(String(v||'').match(/(?:19|20)\d{2}/g)||[]).forEach(y=>ys.add(Number(y)))})});return [...ys].sort((a,b)=>a-b)};
 window.masterCounts=function(){return {countries:registryCountries().length,cities:CANONICAL_CITIES.length,years:canonicalYears().length}};
 window.filterYear=function(y){document.getElementById('detailMapStage').style.display='none';current=(y==='all'||y==='')?[...ALL]:ALL.filter(d=>yearsOf(d).includes(Number(y)));if(globe)globe.pointsData(current.filter(d=>Number.isFinite(d.lat)&&Number.isFinite(d.lng)));updateNums();renderList();const s=document.getElementById('yearSelect');if(s)s.value=String(y);};
 window.openYearRoute=function(y){closeDates();filterYear(y);stopGlobeRotation();};
 window.openCountryRoute=function(name,year){const ds=ALL.filter(d=>normCountry(d.country)===normCountry(name)&&(!year||yearsOf(d).includes(Number(year))));closeDates();closeCountriesTerritories();if(ds.length===1){openPlace(ds[0]);return;}openCountriesTerritories();setTimeout(()=>showCountryRegistryDetails(name,year),0);};
 window.showCountryRegistryDetails=function(name,year){
  const d=document.getElementById('countryRegistryDetails'),r=registryCountries().find(x=>normCountry(x.name)===normCountry(name));
  const ds=ALL.filter(x=>normCountry(x.country)===normCountry(name)&&(!year||yearsOf(x).includes(Number(year)))).sort((a,b)=>(yearsOf(a)[0]||9999)-(yearsOf(b)[0]||9999)||a.name.localeCompare(b.name));
  d.style.display='block';
  d.innerHTML=`<div class="countryDetailHeading">${countryPhotoThumbnailHtml(name)}<div><b>${escHtml(name)}${year?' · '+year:''}</b><div class="note">${escHtml(r?.status||'Confirmed')}</div></div><button onclick="editCountryEntry('${escJs(name)}')">✎ Edit / add details</button></div>`+
   (ds.length?`<div class="repair-note">Choose a destination — every item opens the same destination/pushpin/photo record.</div>${ds.map(x=>`<div class="countryrow clickroute" role="button" tabindex="0" onclick="closeCountriesTerritories();openPlaceByKey('${escJs(x.name)}','${escJs(x.country)}','${escJs(x.year)}')"><span class="countryname">📍 ${escHtml(x.name)}</span><span class="countrymeta">${escHtml(x.date||yearsOf(x).join('/'))}${x.photoAudit?.status==='known-supplied'?' · 📷 photos known supplied / reassociation pending':''}</span></div>`).join('')}`:`<div class="repair-note">Country/territory is confirmed, but a destination pushpin has not yet been established. Use ✎ Edit / add details when the destination is known.</div>`);
  d.scrollIntoView({behavior:'smooth',block:'nearest'});
 };
 window.openCountry=function(name){const ds=ALL.filter(x=>normCountry(x.country)===normCountry(name));if(ds.length===1){closeCountriesTerritories();openPlace(ds[0]);return;}showCountryRegistryDetails(name)};
 window.renderDates=function(){
  const box=document.getElementById('datesList'); const ys=canonicalYears().slice().sort((a,b)=>b-a);
  box.innerHTML=ys.map(y=>{const ds=destinationsForYear(y);const countries=countriesForYear(y);const byCountry=countries.map(c=>{const cds=ds.filter(d=>normCountry(d.country)===normCountry(c));return `<div style="margin:7px 0 10px 12px;padding-left:10px;border-left:2px solid #ffffff20"><div class="countryrow clickroute" onclick="openCountryRoute('${escJs(c)}',${y})">${countryPhotoThumbnailHtml(c)}<span class="countryname">🌍 ${escHtml(c)}</span><span class="countrymeta">${cds.length} destination${cds.length===1?'':'s'} · click to explore</span></div>${cds.map(d=>`<div class="listitem clickroute" style="margin-left:10px" onclick="event.stopPropagation();closeDates();openPlaceByKey('${escJs(d.name)}','${escJs(d.country)}','${escJs(d.year)}')">📍 <b>${escHtml(d.name)}</b> <span class="badge">${escHtml(d.date||String(y))}</span>${d.photoAudit?.status==='known-supplied'?` <span class="badge">📷 reassociation pending</span>`:''}</div>`).join('')}</div>`}).join('');return `<div class="continent yearRoute"><button class="clickroute" onclick="openYearRoute(${y})">📅 ${y} · ${countries.length} countr${countries.length===1?'y':'ies'} visited</button><button onclick="toggleDateYear('${y}')" title="Show/hide details">▾</button></div><div id="dateyear_${y}" style="display:block"><div style="margin:6px 0 8px 12px">${countries.map(c=>`<span class="countrychip" onclick="openCountryRoute('${escJs(c)}',${y})">${escHtml(c)}</span>`).join('')}</div>${byCountry||'<div class="note">Travel year documented; destination details pending.</div>'}</div>`}).join('');
 };
 window.setupYears=function(){const ys=canonicalYears();const s=document.getElementById('yearSelect');s.innerHTML='<option value="all">Travel by year</option>';ys.forEach(y=>{let o=document.createElement('option');o.value=y;o.textContent=y+' · '+countriesForYear(y).length+' countries';s.appendChild(o)});s.onchange=()=>filterYear(s.value);const b=document.getElementById('yearBtns');b.innerHTML='';ys.forEach(y=>{let x=document.createElement('button');x.textContent=y;x.onclick=()=>filterYear(y);b.appendChild(x)})};
 // Make the main destination list a route to the canonical destination viewer.
 const oldRenderList=window.renderList;
 window.renderList=function(){if(typeof oldRenderList==='function')oldRenderList();document.querySelectorAll('#list .item,#list .listitem').forEach(el=>el.classList.add('clickroute'));};
 // Rebuild globe points and menus after repair records are installed.
 if(globe)globe.pointsData(ALL.filter(d=>Number.isFinite(d.lat)&&Number.isFinite(d.lng)));
 setupYears();updateNums();renderList();
})();

;

// Primary photo recovery: only files physically present in this project and supported by GPS/previous audit.
const ADDITIONAL_RECOVERED_PHOTOS = {"Ha Long Bay": [{"src": "assets/images/2a6dcdb93569bf40564f220fa17f3b59b880afacc2f228c407cd6dbcf28d2ee7.jpg", "filename": "PXL_20230722_034847207.jpg", "source": "Primary uploaded photo + GPS metadata audit"}], "Ninh B\u00ecnh / Tam C\u1ed1c": [{"src": "assets/images/67549219cf1bdff146a6e3680ef5abe95c5c959ed57ec11791653fe396e70a5b.jpg", "filename": "PXL_20230724_042542968.PORTRAIT.jpg", "source": "Primary uploaded photo + GPS metadata audit"}], "Wulai": [{"src": "assets/images/37c802bceb9562cf57fc3d9a8d754f129a1c0dd1cae9a43f8804e7f02e0b3d83.jpg", "filename": "PXL_20230728_062808991.MP.jpg", "source": "Primary uploaded photo + GPS metadata audit"}], "Taipei": [{"src": "assets/images/24adb3c9012a02f2b460f7e7246ea7a4a9e31b6532750fa49211cad91e5d1c31.jpg", "filename": "PXL_20230728_120258015.jpg", "source": "Primary uploaded photo + GPS metadata audit"}], "Big Island": [{"src": "assets/images/4e8159cb009abdaef417f4e6f6350735580f875feed254faa4936f52e7621202.jpg", "filename": "PXL_20240122_211612523.jpg", "source": "Primary uploaded photo + GPS metadata audit"}], "Maui": [{"src": "assets/images/7ef0c0b726ef97388dedb13c910d94828cec07b6d6cb7634545ebe0d1c448669.jpg", "filename": "PXL_20241222_222523702.MP.jpg", "source": "Primary uploaded photo + GPS metadata audit"}], "Yosemite": [{"src": "assets/images/809f088b3aa832ced768fa040618086e35f60d2decb419491f1c06e54fb2a1f4.jpg", "filename": "PXL_20250725_214346391.jpg", "source": "Primary uploaded photo + GPS metadata audit"}]};
(function recoverPrimaryPhotos(){
  try {
    Object.entries(ADDITIONAL_RECOVERED_PHOTOS).forEach(([name,photos])=>{
      const d=ALL.find(x=>String(x.name||'').toLowerCase()===name.toLowerCase());
      if(!d)return;
      d.photos=Array.isArray(d.photos)?d.photos:[];
      const seen=new Set(d.photos.map(p=>p&&p.src).filter(Boolean));
      photos.forEach(p=>{if(!seen.has(p.src)){d.photos.push(p);seen.add(p.src)}});
      if(!d.photo && d.photos[0]) d.photo=d.photos[0].src;
      if(d.photoAudit) d.photoAudit.pendingImageIntegration=false;
    });
  } catch(e) { console.warn('Primary photo recovery patch',e); }
})();

function finalizeBaseRecords(){
  let nextId=BASE_ALL.length;
  const used=new Set();
  const records=ALL.map(destination=>{
    const existing=BASE_ALL.find(record=>
      !used.has(record._baseId)
      && record.name===destination.name
      && normCountry(record.country)===normCountry(destination.country)
    );
    const baseId=existing?existing._baseId:`base_${nextId++}`;
    used.add(baseId);
    const record={...destination,_baseId:baseId};
    delete record.heroStatus;
    delete record.heroSource;
    delete record.benVisibleEstablished;
    return record;
  });
  BASE_ALL.splice(0,BASE_ALL.length,...records);
  ALL=records;
}

// Pixel/mobile zoom uses the globe controls native two-finger dolly; pan is disabled.


;

(function(){
  // V18 keeps V17 globe/touch/pinch/menu behavior untouched.
  // Restore already-documented 2016 Europe records only where absent from the living destination array.
  const recovery=[
    {name:'Dolomites',country:'Italy',lat:46.54,lng:11.85,year:2016,visitYears:[2016],date:'Jul 22–26, 2016',note:'2016 Europe trip · existing destination/photo record'},
    {name:'Ljubljana',country:'Slovenia',lat:46.0569,lng:14.5058,year:2016,visitYears:[2016],date:'Jul 19, 2016',note:'2016 Europe trip'},
    {name:'Lake Bled',country:'Slovenia',lat:46.3683,lng:14.1146,year:2016,visitYears:[2016],date:'Jul 2016',note:'2016 Europe trip'},
    {name:'Innsbruck',country:'Austria',lat:47.2692,lng:11.4041,year:2016,visitYears:[2016],date:'Jul 27, 2016',note:'2016 Europe trip · existing destination/photo record'}
  ];
  const key=d=>String(d.name||'').trim().toLowerCase()+'|'+String(d.country||'').trim().toLowerCase();
  const existing=new Set(ALL.map(key));
  recovery.forEach(r=>{if(!existing.has(key(r))){ALL.push(r);existing.add(key(r));}});

  // A year button is now a doorway into the same detailed Dates/year route.
  window.openYearFromGlobe=function(y){
    const s=document.getElementById('yearSelect');
    if(s)s.value=String(y);
    filterYear(y);
    renderDates();
    document.getElementById('datesBack').style.display='flex';
    const section=document.getElementById('dateyear_'+y);
    if(section){section.style.display='block';setTimeout(()=>section.scrollIntoView({block:'start',behavior:'smooth'}),30);}
  };

  window.setupYears=function(){
    const ys=canonicalYears();
    const s=document.getElementById('yearSelect');
    s.innerHTML='<option value="all">Travel by year</option>';
    ys.forEach(y=>{
      const o=document.createElement('option');
      o.value=y;o.textContent=y+' · '+countriesForYear(y).length+' countries';
      s.appendChild(o);
    });
    s.onchange=()=>{if(s.value&&s.value!=='all')openYearFromGlobe(s.value);else filterYear('all')};
    const b=document.getElementById('yearBtns');
    b.innerHTML='';
    ys.forEach(y=>{
      const x=document.createElement('button');
      x.textContent=y;
      x.setAttribute('aria-label','Open travel details for '+y);
      x.onclick=()=>openYearFromGlobe(y);
      b.appendChild(x);
    });
  };

  // Rebind the living globe data after the conservative recovery.
  current=[...ALL];
  if(globe){
    const mappable=ALL.filter(d=>Number.isFinite(d.lat)&&Number.isFinite(d.lng));
    globe.pointsData(mappable);
    globe.htmlElementsData(mappable);
  }
  setupYears();
  updateNums();
  renderList();
})();

;

(function(){
  // Fix only the two V18 panel reopening/display issues.
  const originalRenderCountryRegistry=window.renderCountryRegistry;
  window.openCountriesTerritories=function(){
    closeMobileMenu();
    const back=document.getElementById('countriesBack');
    back.classList.add('v19open');
    back.style.display='flex';
    if(typeof originalRenderCountryRegistry==='function') originalRenderCountryRegistry();
    // Render again after the modal is visible on mobile browsers.
    requestAnimationFrame(()=>{
      if(typeof originalRenderCountryRegistry==='function') originalRenderCountryRegistry();
      const list=document.getElementById('countryRegistryList');
      if(list) list.scrollTop=0;
    });
  };
  window.closeCountriesTerritories=function(){
    const back=document.getElementById('countriesBack');
    back.classList.remove('v19open');
    back.style.display='none';
  };

  window.toggleStats=function(){
    closeMobileMenu();
    const p=document.getElementById('panel');
    const hidden=getComputedStyle(p).display==='none' || !p.classList.contains('v19open');
    if(hidden){
      p.classList.add('v19open');
      p.style.display='block';
      p.style.visibility='visible';
      p.style.opacity='1';
    }else{
      p.classList.remove('v19open');
      p.style.display='none';
    }
  };
  window.closeStats=function(){
    const p=document.getElementById('panel');
    p.classList.remove('v19open');
    p.style.display='none';
  };

  // The panel starts visible in V18; mark that state so the first toggle behaves correctly.
  const p=document.getElementById('panel');
  if(p && getComputedStyle(p).display!=='none') p.classList.add('v19open');
})();

;

(function(){
  // Year -> trip/country -> destination -> canonical destination viewer.
  window.closeV20YearRoute=function(){document.getElementById('v20YearRouteBack').style.display='none';};
  window.openYearFromGlobe=function(y){
    y=Number(y);
    const sel=document.getElementById('yearSelect'); if(sel)sel.value=String(y);
    filterYear(y);
    const trips=[...(TRIP_DATE_REGISTRY[y]||[])];
    const yearDests=ALL.filter(d=>yearsOf(d).includes(y));
    const used=new Set();
    let html='';
    trips.forEach(t=>{
      const dests=(t.destinations||[]).map(n=>yearDests.find(d=>d.name===n)).filter(Boolean);
      dests.forEach(d=>used.add(d));
      const countries=[...new Set(dests.map(d=>d.country).filter(Boolean))];
      html+=`<div class="v20trip">${tripPhotoThumbnailHtml({...t,destinations:t.destinations})}<b>✈️ ${escHtml(t.name)}</b> <span class="badge">${escHtml(t.date||String(y))}</span>`+
        (countries.length?`<div class="v20country">🌍 ${countries.map(country=>`${countryPhotoThumbnailHtml(country)}${escHtml(country)}`).join(' · ')}</div>`:'')+
        (dests.length?dests.map(d=>`<button class="v20dest" onclick="closeV20YearRoute();openPlaceByKey('${escJs(d.name)}','${escJs(d.country)}','${escJs(d.year)}')">📍 <b>${escHtml(d.name)}</b> <span class="badge">${escHtml(d.country||'')}</span>${d.date?` <span class="badge">${escHtml(d.date)}</span>`:''}</button>`).join(''):
        '<div class="note">Trip documented; destination details still being connected.</div>')+
        `</div>`;
    });
    const extras=yearDests.filter(d=>!used.has(d));
    if(extras.length){
      const groups={}; extras.forEach(d=>(groups[d.country||'Other']??=[]).push(d));
      html+='<div class="v20trip"><b>🌍 Other documented destinations this year</b>'+
        Object.entries(groups).sort().map(([c,ds])=>`<div class="v20country">${countryPhotoThumbnailHtml(c)}${escHtml(c)}</div>`+
          ds.map(d=>`<button class="v20dest" onclick="closeV20YearRoute();openPlaceByKey('${escJs(d.name)}','${escJs(d.country)}','${escJs(d.year)}')">📍 <b>${escHtml(d.name)}</b>${d.date?` <span class="badge">${escHtml(d.date)}</span>`:''}</button>`).join('')
        ).join('')+'</div>';
    }
    if(!html)html='<div class="note">Travel year documented; destination details are still being connected.</div>';
    document.getElementById('v20YearRouteTitle').textContent='📅 '+y+' Travel';
    document.getElementById('v20YearRouteList').innerHTML=html;
    closeMobileMenu();
    document.getElementById('v20YearRouteBack').style.display='flex';
  };

  // Rebind both year surfaces to the primary-data route.
  window.setupYears=function(){
    const ys=canonicalYears(), sel=document.getElementById('yearSelect');
    sel.innerHTML='<option value="all">Travel by year</option>';
    ys.forEach(y=>{const o=document.createElement('option');o.value=y;o.textContent=y+' · '+countriesForYear(y).length+' countries';sel.appendChild(o)});
    sel.onchange=()=>{if(sel.value&&sel.value!=='all')openYearFromGlobe(sel.value);else filterYear('all')};
    const b=document.getElementById('yearBtns'); b.innerHTML='';
    ys.forEach(y=>{const x=document.createElement('button');x.textContent=y;x.onclick=()=>openYearFromGlobe(y);b.appendChild(x)});
  };

  // Desktop/Chromebook: direct wheel/trackpad camera zoom, deeper range; mobile pinch controls are untouched.
  const globeEl=document.getElementById('globe');
  if(globeEl && window.matchMedia('(pointer:fine)').matches){
    globeEl.addEventListener('wheel',function(e){
      e.preventDefault(); e.stopImmediatePropagation(); stopGlobeRotation();
      if(!globe)return;
      const p=globe.pointOfView(), alt=Number.isFinite(p.altitude)?p.altitude:2.2;
      const magnitude=Math.min(0.22,Math.max(0.055,Math.abs(e.deltaY)/900));
      const factor=e.deltaY>0?(1+magnitude):(1-magnitude);
      const next=Math.max(0.045,Math.min(6,alt*factor));
      globe.pointOfView({lat:p.lat,lng:p.lng,altitude:next},70);
    },{capture:true,passive:false});
  }
  setupYears();
})();

;

(function(){
  // Travel Numbers: countries and years are navigation; remove inaccurate cities statistic.
  const countriesNum=document.getElementById('countries')?.closest('.num');
  const citiesNum=document.getElementById('cities')?.closest('.num');
  const yearsNum=document.getElementById('years')?.closest('.num');
  if(citiesNum)citiesNum.classList.add('v21CitiesRemoved');
  if(countriesNum){
    countriesNum.setAttribute('role','button');countriesNum.tabIndex=0;
    countriesNum.title='Open all Countries & Territories';
    countriesNum.onclick=()=>openCountriesTerritories();
    countriesNum.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openCountriesTerritories();}};
  }
  if(yearsNum){
    yearsNum.setAttribute('role','button');yearsNum.tabIndex=0;
    yearsNum.title='Open Travel by Year';
    yearsNum.onclick=()=>{
      const ys=canonicalYears();
      if(ys.length) openYearFromGlobe(ys[ys.length-1]);
    };
    yearsNum.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();yearsNum.click();}};
  }

  // Closing a year view always restores the full globe and selector.
  window.closeV20YearRoute=function(){
    document.getElementById('v20YearRouteBack').style.display='none';
    const sel=document.getElementById('yearSelect');if(sel)sel.value='all';
    filterYear('all');
  };

  // Desktop-only zoom buttons: guaranteed visible, plus/minus, using the existing camera helper.
  if(window.matchMedia('(pointer:fine)').matches){
    let controls=document.getElementById('globeZoomControls');
    if(!controls){
      controls=document.createElement('div');controls.id='globeZoomControls';
      controls.innerHTML='<button type="button" aria-label="Zoom in" title="Zoom in">+</button><button type="button" aria-label="Zoom out" title="Zoom out">−</button>';
      document.body.appendChild(controls);
    }
    const bs=controls.querySelectorAll('button');
    if(bs[0])bs[0].onclick=()=>zoomGlobe(-1);
    if(bs[1])bs[1].onclick=()=>zoomGlobe(1);
    controls.style.display='flex';
  }
})();

;

(function(){
  // Desktop camera zoom: use OrbitControls dolly directly instead of the pointOfView helper.
  window.v22GlobeZoom=function(direction){
    if(!globe)return;
    stopGlobeRotation();
    const c=globe.controls();
    c.enableZoom=true;
    c.minDistance=50;
    c.maxDistance=1600;
    const scale=direction<0?0.72:1.38;
    if(c.object && c.target){
      const offset=c.object.position.clone().sub(c.target);
      offset.multiplyScalar(scale);
      c.object.position.copy(c.target.clone().add(offset));
      c.update();
    }
  };
  if(window.matchMedia('(pointer:fine)').matches){
    const el=document.getElementById('globe');
    el.addEventListener('wheel',function(e){
      e.preventDefault();e.stopImmediatePropagation();
      v22GlobeZoom(e.deltaY>0?1:-1);
    },{capture:true,passive:false});
  }

  // Detailed map: keep every documented mappable destination on the map.
  let v22Markers=[];
  function clearV22Markers(){v22Markers.forEach(m=>{try{m.remove()}catch(e){}});v22Markers=[];}
  window.v22AddDestinationMarkers=function(selected){
    if(!map || typeof L==='undefined')return;
    clearV22Markers();
    const mappable=ALL.filter(d=>Number.isFinite(d.lat)&&Number.isFinite(d.lng));
    mappable.forEach(d=>{
      const icon=L.divIcon({className:'',html:'<div class="v22MapPin"></div>',iconSize:[13,13],iconAnchor:[6,6]});
      const m=L.marker([d.lat,d.lng],{icon,keyboard:true,title:d.name}).addTo(map);
      m.bindTooltip(d.name+' · '+d.country,{direction:'top'});
      m.on('click',()=>{
        activeDestination=d;
        showMapInfo(d);
        document.getElementById('mapTitle').textContent=d.name+' — detailed street map';
      });
      v22Markers.push(m);
    });
  };

  const originalOpenDetailedMap=window.openDetailedMap;
  window.openDetailedMap=function(d){
    originalOpenDetailedMap(d);
    // Original map is initialized asynchronously; add the complete travel layer afterward.
    setTimeout(()=>v22AddDestinationMarkers(d),450);
    setTimeout(()=>v22AddDestinationMarkers(d),900);
  };
})();

finalizeBaseRecords();
initializeFamilyCloud();
