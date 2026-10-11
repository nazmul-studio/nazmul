import { gsap } from 'gsap';
import { renderPageToCanvas, onImageLoaded } from './book/render';

export function createTome(T, camera, coverUrl, initialPages) {
  const root = new T.Group();
  camera.add(root);
  root.position.set(0, -0.5, -9);
  root.rotation.set(-0.12, 0, 0);
  root.visible = false;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let disposed = false;
  const colors = { leather: 0x111b22, gold: 0xc9a24a, paper: 0xdfe7e0, blue: 0x38bdf8 };
  const loader = new T.TextureLoader();
  const coverTex = loader.load(coverUrl); coverTex.encoding = T.sRGBEncoding;
  const coverMat = new T.MeshStandardMaterial({ map: coverTex, roughness: 0.8, metalness: 0.28 });
  // Swaps the cover image later (the Studio can upload one). The newest request wins, and a cover that fails to
  // load leaves the current one in place rather than showing a blank book.
  let coverRequest = 0;
  function setCover(url) {
    if (disposed || !url) return;
    const request = ++coverRequest;
    loader.load(url, (texture) => {
      if (disposed || request !== coverRequest) { texture.dispose(); return; }
      texture.encoding = T.sRGBEncoding;
      const previous = coverMat.map;
      coverMat.map = texture; coverMat.needsUpdate = true;
      if (previous && previous !== texture) previous.dispose();
    }, undefined, () => {});
  }
  const gold = new T.MeshStandardMaterial({ color: colors.gold, metalness: 0.8, roughness: 0.35 });
  const leather = new T.MeshStandardMaterial({ color: colors.leather, roughness: 0.9 });
  function panel(x, z, material, depth = 0.12) {
    const mesh = new T.Mesh(new T.BoxGeometry(2.7, 3.7, depth), material);
    mesh.position.set(x, 0, z); root.add(mesh); return mesh;
  }
  const back = panel(1.35, -0.15, leather);
  const edge = panel(1.35, 0, new T.MeshStandardMaterial({ color: colors.paper, roughness: 1 }), 0.2);
  const hinge = new T.Group(); root.add(hinge);
  hinge.position.z = 0.2;
  const front = new T.Mesh(new T.BoxGeometry(2.8, 3.8, 0.12), [leather, leather, gold, gold, coverMat, leather]);
  front.position.set(1.35, 0, 0); hinge.add(front);
  const seam = new T.Mesh(new T.CylinderGeometry(0.11, 0.11, 3.8, 12), gold); root.add(seam);
  const seamLight = new T.Mesh(new T.PlaneGeometry(0.045,3.65),new T.MeshBasicMaterial({color:colors.blue,toneMapped:false,transparent:true,opacity:0}));
  seamLight.position.z=0.32;root.add(seamLight);
  const light = new T.PointLight(colors.blue, 0, 11, 1.4); light.position.set(0, 0, 1.6); root.add(light);
  const key = new T.PointLight(colors.paper, 1.1, 20); key.position.set(0, 4, 5); root.add(key);
  const glowCanvas = document.createElement('canvas'); glowCanvas.width = glowCanvas.height = 128;
  const gc = glowCanvas.getContext('2d');
  if (gc) { const g = gc.createRadialGradient(64,64,0,64,64,64); g.addColorStop(0,'rgba(56,189,248,.65)'); g.addColorStop(0.25,'rgba(56,189,248,.3)'); g.addColorStop(1,'rgba(56,189,248,0)'); gc.fillStyle=g; gc.fillRect(0,0,128,128); }
  const glow = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(glowCanvas), transparent: true, blending: T.AdditiveBlending, depthWrite: false, opacity: 0 }));
  glow.scale.set(1.6,6,1); glow.position.set(0,0,-0.3); root.add(glow);
  let pages = initialPages, current = 0, requested = 0, opened = false, turning = false;
  const textureCache = new Map();
  // Pages are painted by the canonical Book renderer (src/lib/book/render.ts), the same code
  // the Studio Book Editor and Preview use. `pages` is a list of leaves: { front, back }.
  function pageTexture(page) {
    const canvas = document.createElement('canvas');
    renderPageToCanvas(canvas, page, 1);
    const tex=new T.CanvasTexture(canvas); tex.encoding=T.sRGBEncoding; tex.anisotropy=4; return tex;
  }
  function texture(index, back=false) { const key=`${index}:${back}`;if(!textureCache.has(key))textureCache.set(key,pageTexture(back?pages[index]?.back:pages[index]?.front));return textureCache.get(key); }
  const leftMat = new T.MeshBasicMaterial({ map: texture(0), side:T.DoubleSide, fog:false, toneMapped:false });
  const rightMat = new T.MeshBasicMaterial({ map: texture(0,true), side:T.DoubleSide, fog:false, toneMapped:false });
  const left = new T.Mesh(new T.PlaneGeometry(2.62,3.58),leftMat); left.position.set(-1.35,0,0.29); root.add(left);
  const right = new T.Mesh(new T.PlaneGeometry(2.62,3.58),rightMat); right.position.set(1.35,0,0.13); root.add(right);
  left.visible=false;
  const curlGeo=new T.PlaneGeometry(2.62,3.58,40,8); curlGeo.translate(1.35,0,0);
  const restX = Array.from(curlGeo.attributes.position.array).filter((_,i)=>i%3===0);
  const curl = new T.Mesh(curlGeo,rightMat.clone()); curl.position.z=0.35; root.add(curl); curl.visible=false;
  curl.frustumCulled=false;
  const curlState={progress:0};
  function deform(p) {
    const pos=curlGeo.attributes.position;
    for(let i=0;i<pos.count;i++){
      const x=restX[i]; const u=(x-0.04)/2.62; const angle=p*Math.PI;
      pos.setX(i,x*Math.cos(angle));
      pos.setZ(i,x*Math.sin(angle)+Math.sin(u*Math.PI)*Math.sin(angle)*0.3);
    }
    pos.needsUpdate=true;curlGeo.computeVertexNormals();
  }
  function nextTurn() {
    if(disposed || turning || requested===current || !opened)return;
    const forward=requested>current;
    const target=current+(forward?1:-1);
    turning=true;
    curl.material.map=texture(forward?current:target,true);
    rightMat.map=texture(forward?target:current,true);
    curlState.progress=forward?0:1;deform(curlState.progress);curl.visible=true;
    gsap.to(curlState,{progress:forward?1:0,duration:reduce?0:1.05,ease:'power2.inOut',onUpdate(){deform(curlState.progress);},onComplete(){
      current=target;rightMat.map=texture(current,true);leftMat.map=texture(current);curl.visible=false;turning=false;nextTurn();
    }});
  }
  function turn(index) {
    if(index<0 || index>=pages.length || disposed)return;
    requested=index;nextTurn();
  }
  root.traverse(o=>{o.layers.set(3);if(o.material){const materials=Array.isArray(o.material)?o.material:[o.material];materials.forEach(m=>{m.fog=false;});}});
  function refreshTextures(){textureCache.forEach(t=>t.dispose());textureCache.clear();rightMat.map=texture(current,true);leftMat.map=texture(current);}
  document.fonts?.ready.then(()=>{if(!disposed && !turning)refreshTextures();});
  const stopImages=onImageLoaded(()=>{if(!disposed && !turning)refreshTextures();});
  return {
    update(time, progress) {
      root.visible=progress>2.6 && progress<3.4;
      back.visible=root.visible; edge.visible=root.visible;
      const height=2*9*Math.tan(T.MathUtils.degToRad(camera.fov/2));
      const scale=Math.min(height*camera.aspect*0.86/5.65,height*0.42/3.8);
      root.scale.setScalar(scale);root.position.y=-height*0.01;
      const shouldOpen=progress>2.8 && progress<3.4;
      if(shouldOpen!==opened){opened=shouldOpen;
        gsap.to(hinge.rotation,{y:opened?-Math.PI:0,duration:reduce?0:1.6,ease:'power3.inOut',overwrite:true,onComplete:nextTurn});
        gsap.to(light,{intensity:opened?1.2:0,duration:reduce?0:1.2,overwrite:true});
        gsap.to(glow.material,{opacity:opened?.6:0,duration:reduce?0:1.2,overwrite:true});left.visible=opened;
        gsap.to(seamLight.material,{opacity:opened?1:0,duration:reduce?0:1.2,overwrite:true});
      }
      // Center the cover continuously while it opens, rather than snapping.
      root.position.x=0;
    }, turn, setCover,
    setPages(value){if(!value.length)return;gsap.killTweensOf(curlState);curl.visible=false;turning=false;pages=value;current=Math.min(requested,pages.length-1);requested=current;refreshTextures();},
    dispose(){disposed=true;stopImages();[hinge.rotation,curlState,light,glow.material,seamLight.material].forEach(o=>gsap.killTweensOf(o));textureCache.forEach(t=>t.dispose());leftMat.map?.dispose();glow.material.map?.dispose();root.traverse(o=>{o.geometry?.dispose();if(o.material){const materials=Array.isArray(o.material)?o.material:[o.material];materials.forEach(m=>m.dispose());}});camera.remove(root);coverTex.dispose();}
  };
}