export function createPistolDecalSystem({
  THREE,
  DecalGeometry,
  constants,
  scene,
  pistolRaycaster,
  pistolHitDebugMarker,
  bulletDecalLitMaterial,
  bulletDecalDebugMaterial,
}) {
  const { BULLET_DECAL_MAX_COUNT, BULLET_DECAL_SIZE, BULLET_DECAL_SIZE_VARIANCE } = constants;

  const bulletDecalNormal = new THREE.Vector3();
  const bulletDecalPosition = new THREE.Vector3();
  const bulletDecalLookTarget = new THREE.Vector3();
  const bulletDecalSize = new THREE.Vector3();
  const bulletDecalRotation = new THREE.Euler();
  const bulletDecalProjector = new THREE.Object3D();
  const bulletDecalRayDirection = new THREE.Vector3();
  const bulletDecalNormalMatrix = new THREE.Matrix3();
  const bulletDecalInstanceMatrix = new THREE.Matrix4();
  const bulletDecalInstanceWorldMatrix = new THREE.Matrix4();
  const pistolHitDebugNormal = new THREE.Vector3();
  const pistolDebugHitPoint = new THREE.Vector3();

  const bulletDecals = [];

  function clear() {
    while (bulletDecals.length > 0) {
      const decal = bulletDecals.pop();
      if (!decal) {
        continue;
      }
      scene.remove(decal);
      decal.geometry?.dispose?.();
    }
  }

  function syncMaterials(pistolImpactDebugEnabled) {
    const nextMaterial = pistolImpactDebugEnabled ? bulletDecalDebugMaterial : bulletDecalLitMaterial;
    for (const decal of bulletDecals) {
      decal.material = nextMaterial;
    }
  }

  function pushBulletDecalMesh(decalMesh) {
    scene.add(decalMesh);
    bulletDecals.push(decalMesh);

    while (bulletDecals.length > BULLET_DECAL_MAX_COUNT) {
      const oldest = bulletDecals.shift();
      if (!oldest) {
        continue;
      }
      scene.remove(oldest);
      oldest.geometry?.dispose?.();
    }
  }

  function resolveBulletDecalSurfaceNormal(hit, outNormal) {
    if (!hit?.face || !hit?.object) {
      return false;
    }

    outNormal.copy(hit.face.normal);
    if (hit.object.isInstancedMesh && hit.instanceId !== undefined) {
      hit.object.getMatrixAt(hit.instanceId, bulletDecalInstanceMatrix);
      bulletDecalInstanceWorldMatrix.multiplyMatrices(
        hit.object.matrixWorld,
        bulletDecalInstanceMatrix,
      );
      bulletDecalNormalMatrix.getNormalMatrix(bulletDecalInstanceWorldMatrix);
      outNormal.applyNormalMatrix(bulletDecalNormalMatrix);
    } else {
      bulletDecalNormalMatrix.getNormalMatrix(hit.object.matrixWorld);
      outNormal.applyNormalMatrix(bulletDecalNormalMatrix);
    }
    outNormal.normalize();

    bulletDecalRayDirection.copy(pistolRaycaster.ray.direction);
    if (bulletDecalRayDirection.lengthSq() > 0.000001 && outNormal.dot(bulletDecalRayDirection) > 0) {
      outNormal.negate();
    }

    return true;
  }

  function resolveBulletDecalTransformFromHit(hit) {
    if (!resolveBulletDecalSurfaceNormal(hit, bulletDecalNormal)) {
      return false;
    }

    bulletDecalPosition.copy(hit.point).addScaledVector(bulletDecalNormal, 0.006);
    bulletDecalLookTarget.copy(bulletDecalPosition).add(bulletDecalNormal);
    bulletDecalProjector.position.copy(bulletDecalPosition);
    bulletDecalProjector.lookAt(bulletDecalLookTarget);
    bulletDecalRotation.copy(bulletDecalProjector.rotation);
    bulletDecalRotation.z = Math.random() * Math.PI * 2;
    return true;
  }

  function spawnFallbackBulletDecalPlane(hit, size, pistolImpactDebugEnabled) {
    if (!resolveBulletDecalTransformFromHit(hit)) {
      return false;
    }

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      pistolImpactDebugEnabled ? bulletDecalDebugMaterial : bulletDecalLitMaterial,
    );
    plane.quaternion.copy(bulletDecalProjector.quaternion);
    plane.rotateZ(bulletDecalRotation.z);
    plane.position.copy(bulletDecalPosition);
    plane.renderOrder = 12;
    pushBulletDecalMesh(plane);
    return true;
  }

  function spawnBulletDecal(hit, pistolImpactDebugEnabled) {
    const targetMesh = hit?.object?.isMesh ? hit.object : null;
    if (!targetMesh || !resolveBulletDecalTransformFromHit(hit)) {
      return false;
    }

    const randomizedSize =
      BULLET_DECAL_SIZE + (Math.random() * 2 - 1) * BULLET_DECAL_SIZE_VARIANCE;
    const finalSize = Math.max(0.18, randomizedSize);
    bulletDecalSize.set(finalSize, finalSize, finalSize);

    if (hit.instanceId !== undefined) {
      return spawnFallbackBulletDecalPlane(hit, finalSize, pistolImpactDebugEnabled);
    }

    let decalGeometry = null;
    try {
      decalGeometry = new DecalGeometry(
        targetMesh,
        bulletDecalPosition,
        bulletDecalRotation,
        bulletDecalSize,
      );
    } catch {
      decalGeometry = null;
    }

    if (!decalGeometry?.attributes?.position?.count) {
      decalGeometry?.dispose?.();
      return spawnFallbackBulletDecalPlane(hit, finalSize, pistolImpactDebugEnabled);
    }

    const decalMesh = new THREE.Mesh(
      decalGeometry,
      pistolImpactDebugEnabled ? bulletDecalDebugMaterial : bulletDecalLitMaterial,
    );
    decalMesh.renderOrder = 12;
    pushBulletDecalMesh(decalMesh);
    return true;
  }

  function recordDebugMarker(hit, pistolImpactDebugEnabled) {
    if (!pistolImpactDebugEnabled || !hit?.face || !hit?.object) {
      return false;
    }
    if (!resolveBulletDecalSurfaceNormal(hit, pistolHitDebugNormal)) {
      return false;
    }
    pistolDebugHitPoint.copy(hit.point).addScaledVector(pistolHitDebugNormal, 0.03);
    pistolHitDebugMarker.position.copy(pistolDebugHitPoint);
    pistolHitDebugMarker.visible = true;
    return true;
  }

  return {
    clear,
    syncMaterials,
    spawnBulletDecal,
    recordDebugMarker,
    getCount: () => bulletDecals.length,
    getDecals: () => bulletDecals,
  };
}
