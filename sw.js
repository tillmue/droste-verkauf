const C='droste-v1';
const FILES=['./','index.html','cloud.js','firebase-config.js','i18n-ro.js','manifest.json','logo.jpg','logo.svg','bg.png','icon-180.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(FILES)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('push',e=>{
  let j={};try{j=e.data.json()}catch(x){}
  const d=j.data||j.notification||j;
  e.waitUntil(self.registration.showNotification(d.title||'Hof Droste',{body:d.body||'',icon:'icon-180.png',badge:'icon-180.png',data:{url:d.url||'./'}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=(e.notification.data&&e.notification.data.url)||'./';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
    for(const c of cs){if('focus'in c)return c.focus()}
    return self.clients.openWindow(url);
  }));
});
self.addEventListener('fetch',e=>{
  /* Immer beim Server nachfragen (kein HTTP-Cache von GitHub Pages, sonst bleibt bis zu 10 Minuten die alte Version) */
  const req=e.request.method==='GET'&&e.request.url.startsWith(self.location.origin)?new Request(e.request.url,{cache:'no-cache',credentials:'same-origin'}):e.request;
  e.respondWith(fetch(req).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request)));
});
