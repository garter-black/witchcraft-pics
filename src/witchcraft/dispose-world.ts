import * as T from 'three';

export function disposeObject(root:T.Object3D) {
  const geometries=new Set<T.BufferGeometry>();
  const materials=new Set<T.Material>();
  const textures=new Set<T.Texture>();
  const bitmaps=new Set<{close:()=>void}>();
  const skeletons=new Set<T.Skeleton>();
  root.traverse(object=>{
    const mesh=object as T.Mesh;
    if(mesh.geometry)geometries.add(mesh.geometry);
    if(mesh.material)for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])materials.add(material);
    if(object instanceof T.SkinnedMesh)skeletons.add(object.skeleton);
  });
  for(const material of materials)for(const value of Object.values(material))if(value instanceof T.Texture)textures.add(value);
  for(const texture of textures){
    const images=Array.isArray(texture.image)?texture.image:[texture.image];
    for(const image of images)if(image&&typeof image.close==='function')bitmaps.add(image);
    texture.dispose();
  }
  for(const bitmap of bitmaps)bitmap.close();
  for(const geometry of geometries)geometry.dispose();
  for(const material of materials)material.dispose();
  for(const skeleton of skeletons)skeleton.dispose();
}
