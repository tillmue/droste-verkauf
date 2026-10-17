/* Cloud-Schicht: Firebase Auth + Firestore.
   Verbindet den App-Zustand (window.APP) mit der gemeinsamen Datenbank.
   Prinzip: Die App ändert wie bisher ihr Objekt S und ruft save(). save() ruft cloud.sync(),
   das nur geänderte Dokumente schreibt. Snapshot-Listener schreiben Änderungen anderer zurück in S. */
const V = '10.14.1', BASE = 'https://www.gstatic.com/firebasejs/' + V + '/';

async function loadFB() {
  const [a, au, fs] = await Promise.all([
    import(BASE + 'firebase-app.js'), import(BASE + 'firebase-auth.js'), import(BASE + 'firebase-firestore.js')]);
  return { ...a, ...au, ...fs };
}

const clean = o => JSON.parse(JSON.stringify(o));
function stable(o) {
  if (o === undefined) return 'null';
  if (o && typeof o === 'object') {
    if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
    return '{' + Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
  }
  return JSON.stringify(o);
}

function initCloud(FB) {
  const T = window.APP;
  const app = FB.initializeApp(window.FIREBASE_CONFIG);
  const auth = FB.getAuth(app);
  auth.languageCode = (() => { try { return localStorage.getItem('droste-lang') === 'ro' ? 'ro' : 'de'; } catch (e) { return 'de'; } })();
  let db;
  try {
    db = FB.initializeFirestore(app, { experimentalAutoDetectLongPolling: true, localCache: FB.persistentLocalCache({ tabManager: FB.persistentMultipleTabManager() }) });
  } catch (e) { console.warn('Offline-Cache nicht verfügbar', e); db = FB.getFirestore(app); }

  /* Sammlungen: get() liefert [id, objekt]-Paare aus S, put(map) schreibt die Dokumente zurück in S */
  const defs = {
    tasks:    { get: () => T.S.tasks.map(x => [x.id, x]),  put: m => { T.S.tasks = Object.values(m); }, del: true },
    events:   { get: () => T.S.events.map(x => [x.id, x]), put: m => { T.S.events = Object.values(m); }, del: true },
    notes:    { get: () => T.S.notes.map(x => [x.id, x]),  put: m => { T.S.notes = Object.values(m); }, del: false },
    settings: { get: () => { const h = T.S.hofInfo || {}; return (h.address || h.paypal || h.orte || (h.vehicles && h.vehicles.length)) ? [['hof', h]] : []; },
                put: m => { const h = m.hof || {}; T.S.hofInfo = { address: h.address || '', paypal: h.paypal || '', vehicles: h.vehicles || [], orte: h.orte || '' }; }, del: true },
    packs:    { get: () => T.S.packs.map(x => [x.id, x]), put: m => { T.S.packs = Object.values(m); }, del: false, maps: ['checks'] },
    feld:     { get: () => T.S.feld.map(x => [x.id, x]), put: m => { T.S.feld = Object.values(m); }, del: false, maps: ['bal'] },
    tours:    { get: () => T.S.tours.map(x => [x.id, x]), put: m => { T.S.tours = Object.values(m); }, del: false, maps: ['stops'] },
    shopping: { get: () => T.S.shopping.map(x => [x.id, x]), put: m => { T.S.shopping = Object.values(m); }, del: false },
    penalties:{ get: () => T.S.penalties.map(x => [x.id, x]), put: m => { T.S.penalties = Object.values(m); }, del: false },
    products: { get: () => T.S.products.map(x => [x.id, x]), ordered: true, del: true,
                put: m => { T.S.products = Object.values(m).sort((a, b) => a._o - b._o).map(({ _o, ...r }) => r); } },
    stands:   { get: () => T.S.stands.map(x => [x.id, x]), ordered: true, del: true,
                put: m => { T.S.stands = Object.values(m).sort((a, b) => a._o - b._o).map(({ _o, ...r }) => r);
                            if (T.S.stands.length && !T.S.stands.some(s => s.id === T.cur.stand)) T.cur.stand = T.S.stands[0].id; } },
    moves:    { get: () => T.S.moves.map(x => [x.id, x]), put: m => { T.S.moves = Object.values(m); }, del: true, sales: true },
    sales:    { get: () => Object.entries(T.S.entries), put: m => { T.S.entries = m; }, del: false, sales: true }
  };
  const hydrated = {}, lastSynced = {}, pending = {}, unsubs = [];
  let unsubProfile = null, profile = null, uid = null, activeKey = '', registering = false, seeded = {};

  function setStatus() {
    T.status = !navigator.onLine ? 'offline' : (Object.values(pending).some(Boolean) ? 'wird übertragen' : 'synchronisiert');
    T.updateHeader();
  }
  window.addEventListener('online', setStatus);
  window.addEventListener('offline', setStatus);

  /* iOS friert die Home-Screen-App im Hintergrund ein; die Live-Verbindung bleibt dann tot.
     Beim Zurückkehren Verbindung neu aufbauen, damit Änderungen sofort ankommen. */
  async function resume() {
    if (!FB.disableNetwork || !FB.enableNetwork) return;
    try { await FB.disableNetwork(db); } catch (e) {}
    try { await FB.enableNetwork(db); } catch (e) {}
    setStatus();
  }
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (uid && hiddenAt && Date.now() - hiddenAt > 15000) resume();
  });
  window.addEventListener('pageshow', e => { if (e.persisted && uid) resume(); });
  window.addEventListener('online', () => { if (uid) resume(); });

  function permissionNote(name, id, err) {
    console.error('Schreiben fehlgeschlagen', name, id, err);
    T.toast(err && err.code === 'permission-denied' ? 'Keine Berechtigung für diese Änderung' : 'Speichern fehlgeschlagen, wird erneut versucht');
  }

  function sync() {
    if (!uid || !profile || profile.approved !== true) return;
    for (const [name, d] of Object.entries(defs)) {
      if (!hydrated[name]) continue;
      const cur = {};
      d.get().forEach(([id, o], i) => { cur[id] = clean(d.ordered ? { ...o, _o: i } : o); });
      const last = lastSynced[name] || (lastSynced[name] = {});
      for (const id in cur) {
        const j = stable(cur[id]);
        if (last[id] !== j) {
          const prev = last[id] ? JSON.parse(last[id]) : null;
          last[id] = j;
          if (d.maps && prev) {
            /* nur geänderte Teile schreiben (z. B. einzelne Häkchen oder Stopps), damit sich gleichzeitige Änderungen nicht überschreiben */
            const patch = {};
            for (const key of Object.keys(cur[id])) {
              if (d.maps.includes(key)) {
                const pm = prev[key] || {}, cm = cur[id][key] || {}, sub = {};
                for (const k in cm) if (stable(cm[k]) !== stable(pm[k])) sub[k] = cm[k];
                if (Object.keys(sub).length) patch[key] = sub;
              } else if (stable(cur[id][key]) !== stable(prev[key])) patch[key] = cur[id][key];
            }
            if (Object.keys(patch).length) FB.setDoc(FB.doc(db, name, id), patch, { merge: true }).catch(e => permissionNote(name, id, e));
          } else {
            FB.setDoc(FB.doc(db, name, id), cur[id]).catch(e => permissionNote(name, id, e));
          }
        }
      }
      if (d.del) for (const id in last) if (!(id in cur)) {
        delete last[id];
        FB.deleteDoc(FB.doc(db, name, id)).catch(e => permissionNote(name, id, e));
      }
    }
  }

  function seedIfEmpty(name, snap) {
    if (!(name === 'products' || name === 'stands') || profile.role !== 'admin') return;
    if (seeded[name] || snap.size > 0 || (snap.metadata && snap.metadata.fromCache)) return;
    seeded[name] = true;
    T.S[name] = clean(T.defaults()[name]);
    sync();
  }

  function listen(name) {
    const d = defs[name];
    let q = FB.collection(db, name);
    if (name === 'notes' && profile.role !== 'admin') q = FB.query(q, FB.where('ownerUid', '==', uid));
    unsubs.push(FB.onSnapshot(q, snap => {
      const m = {};
      snap.forEach(ds => { m[ds.id] = ds.data(); });
      const map = {}; for (const id in m) map[id] = clean(m[id]);
      lastSynced[name] = {}; for (const id in map) lastSynced[name][id] = stable(map[id]);
      pending[name] = !!(snap.metadata && snap.metadata.hasPendingWrites);
      d.put(name === 'sales' ? map : map);
      hydrated[name] = true;
      if (name === 'tasks' && T.rollTasks) T.rollTasks();
      seedIfEmpty(name, snap);
      T.ready = hydrated.stands && hydrated.products;
      setStatus();
      T.softRender();
    }, err => { console.error(name, err); T.toast('Fehler beim Laden: ' + name); }));
  }

  function deactivate() {
    unsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
    for (const k of Object.keys(hydrated)) delete hydrated[k];
    for (const k of Object.keys(lastSynced)) delete lastSynced[k];
    seeded = {}; T.ready = false; activeKey = '';
  }

  function activate(p, id) {
    const key = id + ':' + p.role + ':' + JSON.stringify(p.perms || null);
    if (activeKey === key) return;
    deactivate(); activeKey = key;
    T.backupLocal();
    const S = T.S;
    S.tasks = []; S.events = []; S.notes = []; S.penalties = []; S.shopping = []; S.packs = []; S.tours = []; S.feld = []; S.hofInfo = { address: '' }; S.moves = []; S.entries = {}; S.products = []; S.stands = [];
    unsubs.push(FB.onSnapshot(FB.collection(db, 'users'), snap => {
      const arr = []; snap.forEach(ds => arr.push({ id: ds.id, ...ds.data() }));
      arr.sort((a, b) => (a.created || 0) - (b.created || 0));
      S.people = arr.map(u => u.name); S.roles = {}; S.approved = {}; S.userIds = {}; S.emailVerified = {}; S.perms = {};
      arr.forEach(u => { S.roles[u.name] = u.role; S.approved[u.name] = u.approved === true; S.userIds[u.name] = u.id; S.emailVerified[u.name] = u.emailVerified === true; if (u.perms) S.perms[u.name] = u.perms; });
      T.softRender();
    }, err => console.error('users', err)));
    ['tasks', 'events', 'notes', 'penalties', 'products', 'stands', 'settings', 'packs'].forEach(listen);
    if (T.permFor(p, 'verkauf') || T.permFor(p, 'zahlen')) ['moves', 'sales'].forEach(listen);
    if (T.permFor(p, 'lieferungen') || T.permFor(p, 'lieferplanung')) listen('tours');
    if (T.permFor(p, 'einkauf')) listen('shopping');
    if (T.permFor(p, 'feld')) listen('feld');
  }

  function watchProfile(user) {
    uid = user.uid;
    const ref = FB.doc(db, 'users', user.uid);
    unsubProfile = FB.onSnapshot(ref, snap => {
      if (!snap.exists()) {
        if (registering) return;
        FB.setDoc(ref, { name: (user.email || 'Neu').split('@')[0], email: (user.email || '').toLowerCase(), role: 'team', approved: false, created: Date.now() })
          .catch(e => console.error(e));
        return;
      }
      profile = snap.data();
      const S = T.S;
      S.me = profile.name; S.myUid = user.uid;
      S.roles = S.roles || {}; S.approved = S.approved || {};
      S.roles[profile.name] = profile.role; S.approved[profile.name] = profile.approved === true;
      S.perms = S.perms || {}; if (profile.perms) S.perms[profile.name] = profile.perms; else delete S.perms[profile.name];
      if (!S.people || !S.people.includes(profile.name)) S.people = [...(S.people || []), profile.name];
      if (user.emailVerified && profile.emailVerified !== true) FB.updateDoc(ref, { emailVerified: true }).catch(() => {});
      T.setCloud({ status: 'in', profile: { ...profile, uid: user.uid, email: user.email, verified: !!user.emailVerified } });
      if (profile.approved === true) activate(profile, user.uid); else { deactivate(); T.softRender(); }
      T.render();
    }, err => { console.error(err); T.setCloud({ status: 'error', msg: 'Profil konnte nicht geladen werden (' + (err.code || err.message) + ')' }); T.render(); });
  }

  FB.onAuthStateChanged(auth, user => {
    if (unsubProfile) { unsubProfile(); unsubProfile = null; }
    if (!user) {
      deactivate(); profile = null; uid = null;
      T.wipe(); T.setCloud({ status: 'out' }); T.render(); return;
    }
    watchProfile(user);
  }, err => { T.setCloud({ status: 'error', msg: 'Anmeldung nicht möglich (' + (err.code || err.message) + ')' }); T.render(); });

  window.cloud = {
    sync, resume,
    signIn: (email, pw) => FB.signInWithEmailAndPassword(auth, email.trim(), pw),
    reset: email => FB.sendPasswordResetEmail(auth, email.trim()),
    async register(name, email, pw) {
      registering = true;
      try {
        const cr = await FB.createUserWithEmailAndPassword(auth, email.trim(), pw);
        await FB.setDoc(FB.doc(db, 'users', cr.user.uid), { name: name.trim(), email: email.trim().toLowerCase(), role: 'team', approved: false, created: Date.now() });
        try { await FB.sendEmailVerification(cr.user); } catch (e) { console.warn('Bestätigungsmail nicht gesendet', e); }
      } finally { registering = false; }
    },
    resendVerification: () => FB.sendEmailVerification(auth.currentUser),
    async refreshVerified() {
      const u = auth.currentUser; if (!u) return;
      await u.reload();
      if (u.emailVerified) {
        FB.updateDoc(FB.doc(db, 'users', u.uid), { emailVerified: true }).catch(() => {});
        T.cur.cloud = { ...T.cur.cloud, profile: { ...T.cur.cloud.profile, verified: true } };
      }
      T.render();
    },
    signOut: () => FB.signOut(auth),
    setRole: (name, role) => FB.updateDoc(FB.doc(db, 'users', T.S.userIds[name]), { role, perms: T.presetFor(role) }),
    setPerms: (name, perms) => FB.updateDoc(FB.doc(db, 'users', T.S.userIds[name]), { perms }),
    approve: name => FB.updateDoc(FB.doc(db, 'users', T.S.userIds[name]), { approved: true }),
    remove: name => FB.deleteDoc(FB.doc(db, 'users', T.S.userIds[name])),
    afterImport() { for (const k of Object.keys(lastSynced)) lastSynced[k] = lastSynced[k] || {}; sync(); }
  };
  return window.cloud;
}

window.cloudInit = initCloud;
if (window.FIREBASE_CONFIG && !/manualcloud/.test(location.search)) {
  loadFB().then(initCloud).catch(e => {
    console.error(e);
    window.APP.setCloud({ status: 'error', msg: 'Verbindung zu Firebase nicht möglich. Bitte Netz prüfen und neu laden.' });
    window.APP.render();
  });
}
