import { Mesh, MeshStandardMaterial, SRGBColorSpace, type Material, type Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { SourceModel } from '../types';

export async function loadGlb(file: File): Promise<SourceModel> {
  const buffer = await file.arrayBuffer();
  return loadGlbBuffer(buffer, file.name, file.size);
}

export async function loadGlbBuffer(buffer: ArrayBuffer, name: string, bytes = buffer.byteLength): Promise<SourceModel> {
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  let triangles = 0;
  let meshes = 0;
  const materials = new Set<Material>();
  const textures = new Set<Texture>();

  gltf.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    meshes += 1;
    const positionCount = object.geometry.attributes.position?.count ?? 0;
    triangles += Math.floor((object.geometry.index?.count ?? positionCount) / 3);
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of meshMaterials) {
      materials.add(material);
      if (material instanceof MeshStandardMaterial) {
        for (const texture of [material.map, material.emissiveMap]) {
          if (!texture) continue;
          texture.colorSpace = SRGBColorSpace;
          textures.add(texture);
        }
      }
    }
  });
  gltf.scene.updateMatrixWorld(true);

  return {
    scene: gltf.scene,
    name,
    bytes,
    triangles,
    meshes,
    materials: materials.size,
    textures: textures.size,
  };
}
