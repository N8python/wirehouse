import * as THREE from "three";

function sampleModelPoints(model) {
  const points = [];
  const vertex = new THREE.Vector3();
  model.updateMatrixWorld(true);
  model.traverse((obj) => {
    if (!obj.isMesh) return;
    const positions = obj.geometry?.attributes?.position;
    if (!positions) return;
    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions, i).applyMatrix4(obj.matrixWorld);
      points.push({ x: vertex.x, y: vertex.y, z: vertex.z });
    }
  });
  return points;
}

function computeEndStats(points) {
  if (points.length === 0) {
    return null;
  }

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }

  const sliceDepth = Math.max((maxZ - minZ) * 0.14, 0.005);
  const minEnd = { sumX: 0, sumY: 0, count: 0, radius: 0, z: minZ };
  const maxEnd = { sumX: 0, sumY: 0, count: 0, radius: 0, z: maxZ };

  for (const point of points) {
    if (point.z <= minZ + sliceDepth) {
      minEnd.sumX += point.x;
      minEnd.sumY += point.y;
      minEnd.count += 1;
      minEnd.radius = Math.max(minEnd.radius, Math.hypot(point.x, point.y));
    }
    if (point.z >= maxZ - sliceDepth) {
      maxEnd.sumX += point.x;
      maxEnd.sumY += point.y;
      maxEnd.count += 1;
      maxEnd.radius = Math.max(maxEnd.radius, Math.hypot(point.x, point.y));
    }
  }

  minEnd.cx = minEnd.count > 0 ? minEnd.sumX / minEnd.count : 0;
  minEnd.cy = minEnd.count > 0 ? minEnd.sumY / minEnd.count : 0;
  maxEnd.cx = maxEnd.count > 0 ? maxEnd.sumX / maxEnd.count : 0;
  maxEnd.cy = maxEnd.count > 0 ? maxEnd.sumY / maxEnd.count : 0;

  return { min: minEnd, max: maxEnd };
}

export function loadFlashlightModel({
  modelLoader,
  modelPath,
  flashlightModelAnchor,
  flashlight,
  flashlightTarget,
  onLoaded,
}) {
  modelLoader.load(
    modelPath,
    (gltf) => {
      const model = gltf.scene;
      model.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.castShadow = false;
        obj.receiveShadow = false;
        if (Array.isArray(obj.material)) {
          for (const material of obj.material) {
            material.side = THREE.FrontSide;
          }
        } else if (obj.material) {
          obj.material.side = THREE.FrontSide;
        }
      });

      const rawBounds = new THREE.Box3().setFromObject(model);
      const rawSize = new THREE.Vector3();
      rawBounds.getSize(rawSize);
      const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z) || 1;
      const scale = 0.55 / maxDim;
      model.scale.setScalar(scale);

      if (rawSize.x >= rawSize.y && rawSize.x >= rawSize.z) {
        model.rotation.y = -Math.PI / 2;
      } else if (rawSize.y >= rawSize.x && rawSize.y >= rawSize.z) {
        model.rotation.x = -Math.PI / 2;
      }

      const centeredBounds = new THREE.Box3().setFromObject(model);
      const center = new THREE.Vector3();
      centeredBounds.getCenter(center);
      model.position.sub(center);

      let endStats = computeEndStats(sampleModelPoints(model));
      if (endStats && endStats.max.radius > endStats.min.radius * 1.04) {
        model.rotation.y += Math.PI;
        endStats = computeEndStats(sampleModelPoints(model));
      }
      model.rotation.z = Math.PI * 0.03;
      endStats = computeEndStats(sampleModelPoints(model));

      if (endStats) {
        const tip = endStats.min;
        const beamZ = tip.z - 0.02;
        flashlight.position.set(tip.cx, tip.cy, beamZ);
        flashlightTarget.position.set(tip.cx, tip.cy, beamZ - 7.2);
      }

      flashlightModelAnchor.clear();
      flashlightModelAnchor.add(model);
      onLoaded?.(true);
    },
    undefined,
    () => {
      onLoaded?.(false);
    },
  );
}
