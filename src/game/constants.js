export function createGameConstants({ THREE, cellSize }) {
  const PISTOL_MUZZLE_FLASH_FRAME_COUNT = 4;
  const PISTOL_MUZZLE_FLASH_FRAME_WIDTH = 1 / PISTOL_MUZZLE_FLASH_FRAME_COUNT;
  const VIEW_BOB_BASE_FREQUENCY = 8.5;
  const VIEW_BOB_BASE_AMPLITUDE = 0.035;
  const VIEW_BOB_SMOOTHING = 12;
  const PICKUP_INTERACT_DISTANCE = 1.9;
  const INVENTORY_MAX_ITEMS = 8;
  const INVENTORY_ROTATION_STEP_DEGREES = 360 / INVENTORY_MAX_ITEMS;
  const INVENTORY_SLOT_RADIUS_PX = 90;
  const PLAYER_MAX_HEALTH = 120;
  const PLAYER_TEST_DAMAGE_PER_PRESS = 5;
  const HEALTH_DAMAGE_TRAIL_DECAY_RATE = 3.2;
  const HEALTH_DAMAGE_TRAIL_MIN_DELTA = 0.01;
  const HEALTH_DAMAGE_TRAIL_HOLD_SECONDS = 0.12;
  const JERKY_ITEM_ID = "meat_jerky_01";
  const JERKY_HEAL_AMOUNT = 60;
  const JERKY_CONSUME_DURATION_SECONDS = 2;
  const JERKY_EAT_BOB_FREQUENCY = 3.6;
  const JERKY_EAT_BOB_AMPLITUDE = 0.05;
  const JERKY_EAT_BOB_DEPTH = 0.018;
  const FIRST_AID_KIT_ITEM_ID = "first_aid_kit_01";
  const FIRST_AID_KIT_HEAL_AMOUNT = 120;
  const FIRST_AID_USE_DURATION_SECONDS = 4;
  const FIRST_AID_REGEN_DURATION_SECONDS = 30;
  const FIRST_AID_REGEN_PER_SECOND = 4;
  const SODA_CAN_ITEM_ID = "soda_can_01";
  const SODA_SPEED_MULTIPLIER = 1.5;
  const SODA_USE_DURATION_SECONDS = 1;
  const SODA_SPEED_DURATION_SECONDS = 30;
  const HEALTH_HEARTBEAT_CYCLE_SECONDS = 1.45;
  const HEALTH_HEARTBEAT_PRIMARY_TIME = 0.09;
  const HEALTH_HEARTBEAT_SECONDARY_TIME = 0.24;
  const HEALTH_HEARTBEAT_PRIMARY_AMPLITUDE = 0.11;
  const HEALTH_HEARTBEAT_SECONDARY_AMPLITUDE = 0.18;
  const HEALTH_HEARTBEAT_WIDTH = 0.035;
  const PISTOL_ITEM_ID = "pistol_01";
  const BULLET_ITEM_ID = "bullet_01";
  const BASEBALL_BAT_ITEM_ID = "baseball_bat_01";
  const PISTOL_FIRE_RANGE = 72;
  const PISTOL_FIRE_COOLDOWN_SECONDS = 0.14;
  const BULLET_DECAL_SIZE = 0.52;
  const BULLET_DECAL_SIZE_VARIANCE = 0.1;
  const BULLET_DECAL_MAX_COUNT = 10;
  const PISTOL_RECOIL_RETURN_RATE = 17;
  const PISTOL_RECOIL_POSITION_KICK = new THREE.Vector3(-0.045, -0.06, 0.24);
  const PISTOL_RECOIL_ROTATION_KICK = new THREE.Vector3(-0.38, 0.1, 0.14);
  const PISTOL_MUZZLE_FLASH_FALLBACK_LOCAL_POSITION = new THREE.Vector3(0.52, 0.04, -0.23);
  const PISTOL_MUZZLE_FORWARD_WORLD_OFFSET = 0.09;
  const PISTOL_MUZZLE_FLASH_DURATION = 0.11;
  const PISTOL_PROP_DEBUG_MARKER_LIFETIME = 0.48;
  const MELEE_WEAPON_CONFIG = {
    "knife_01": {
      displayName: "Knife slash",
      range: 2.2,
      cooldownSeconds: 0.25,
      swingDurationSeconds: 0.5,
      swingPositionOffset: [1.0, -0.3, 0.16],
      swingRotationOffset: [Math.PI / 2, -0.2, 0.3],
    },
    "baseball_bat_01": {
      displayName: "Bat swing",
      range: 2.8,
      cooldownSeconds: 0.2,
      swingDurationSeconds: 0.4,
      swingPositionOffset: [0.5, -0.1, -0.1],
      swingRotationOffset: [-2, 1.2, 0],
    },
  };
  const DEBUG_INVENTORY_ITEMS = [
    { id: "knife_01", name: "Knife" },
    { id: "pistol_01", name: "Pistol" },
    { id: "bullet_01", name: "Bullet" },
    { id: "meat_jerky_01", name: "Jerky" },
    { id: "first_aid_kit_01", name: "First Aid Kit" },
    { id: "skull_01", name: "Skull" },
    { id: "soda_can_01", name: "Soda Can" },
    { id: "baseball_bat_01", name: "Baseball Bat" },
  ];
  const HELD_ITEM_DISPLAY_TUNING = {
    "knife_01": {
      targetSize: 1,
      offset: [0.012, 0.2, -0.264],
      rotation: [0.088407346410207, -2.39159265358979, 0.428407346410207],
    },
    "pistol_01": {
      targetSize: 0.56,
      offset: [0.4, 0.052, -0.02],
      rotation: [0.248407346410207, 0.998407346410207, -0.021592653589793],
    },
    bullet_01: {
      targetSize: 0.12,
      offset: [0.04, -0.07, -0.02],
      rotation: [0.34, -1.1, 0.52],
    },
    "meat_jerky_01": {
      targetSize: 0.365,
      offset: [0.216, 0.11, 0.014],
      rotation: [1.46840734641021, -1, 0.968407346410207],
    },
    "first_aid_kit_01": {
      targetSize: 0.545,
      offset: [0.03, 0.024, -0.02],
      rotation: [0.26, 0.008407346410207, 0.7],
    },
    "skull_01": {
      targetSize: 0.415,
      offset: [0.16, 0.292, -0.132],
      rotation: [2.75840734641021, 3.13840734641021, 3.13840734641021],
    },
    "soda_can_01": {
      targetSize: 0.29,
      offset: [0.03, -0.03, -0.02],
      rotation: [0.208407346410207, 0.208407346410207, -0.211592653589793],
    },
    "baseball_bat_01": {
      targetSize: 1,
      offset: [0.034, 0.194, -0.05],
      rotation: [1.48840734641021, -1.17159265358979, 1.43840734641021],
    },
  };
  const ENABLE_HELD_ITEM_TUNING_UI = false;
  const HELD_ITEM_TUNING_SLIDER_DEFS = [
    { key: "targetSize", label: "size", min: 0.04, max: 1, step: 0.005 },
    { key: "offsetX", label: "off x", min: -0.4, max: 0.4, step: 0.002 },
    { key: "offsetY", label: "off y", min: -0.4, max: 0.4, step: 0.002 },
    { key: "offsetZ", label: "off z", min: -0.4, max: 0.4, step: 0.002 },
    { key: "rotX", label: "rot x", min: -Math.PI, max: Math.PI, step: 0.01 },
    { key: "rotY", label: "rot y", min: -Math.PI, max: Math.PI, step: 0.01 },
    { key: "rotZ", label: "rot z", min: -Math.PI, max: Math.PI, step: 0.01 },
  ];
  const TOP_DOWN_PLAYER_LOOK_LENGTH = cellSize * 2.4;
  const FLASHLIGHT_RIG_BASE_POSITION = new THREE.Vector3(0.24, -0.22, -0.38);
  const FLASHLIGHT_RIG_BASE_ROTATION = new THREE.Euler(0.03, -0.1, 0.02);
  const LEFT_HAND_RIG_BASE_POSITION = new THREE.Vector3(-0.34, -0.31, -0.58);
  const LEFT_HAND_RIG_BASE_ROTATION = new THREE.Euler(0.08, 0.42, -0.1);
  const LEFT_HAND_ITEM_BASE_ROTATION = new THREE.Euler(0, 0, 0);
  const LEFT_HAND_ITEM_TARGET_SIZE = 0.22;
  const HELD_ITEM_AMBIENT_BOOST_INTENSITY = 0.42;
  const FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE = new THREE.Color(0.6, 0.6, 0.6);
  const collisionOffsets = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0.7, 0.7],
    [0.7, -0.7],
    [-0.7, 0.7],
    [-0.7, -0.7],
  ];

  return {
    PISTOL_MUZZLE_FLASH_FRAME_COUNT,
    PISTOL_MUZZLE_FLASH_FRAME_WIDTH,
    VIEW_BOB_BASE_FREQUENCY,
    VIEW_BOB_BASE_AMPLITUDE,
    VIEW_BOB_SMOOTHING,
    PICKUP_INTERACT_DISTANCE,
    INVENTORY_MAX_ITEMS,
    INVENTORY_ROTATION_STEP_DEGREES,
    INVENTORY_SLOT_RADIUS_PX,
    PLAYER_MAX_HEALTH,
    PLAYER_TEST_DAMAGE_PER_PRESS,
    HEALTH_DAMAGE_TRAIL_DECAY_RATE,
    HEALTH_DAMAGE_TRAIL_MIN_DELTA,
    HEALTH_DAMAGE_TRAIL_HOLD_SECONDS,
    JERKY_ITEM_ID,
    JERKY_HEAL_AMOUNT,
    JERKY_CONSUME_DURATION_SECONDS,
    JERKY_EAT_BOB_FREQUENCY,
    JERKY_EAT_BOB_AMPLITUDE,
    JERKY_EAT_BOB_DEPTH,
    FIRST_AID_KIT_ITEM_ID,
    FIRST_AID_KIT_HEAL_AMOUNT,
    FIRST_AID_USE_DURATION_SECONDS,
    FIRST_AID_REGEN_DURATION_SECONDS,
    FIRST_AID_REGEN_PER_SECOND,
    SODA_CAN_ITEM_ID,
    SODA_SPEED_MULTIPLIER,
    SODA_USE_DURATION_SECONDS,
    SODA_SPEED_DURATION_SECONDS,
    HEALTH_HEARTBEAT_CYCLE_SECONDS,
    HEALTH_HEARTBEAT_PRIMARY_TIME,
    HEALTH_HEARTBEAT_SECONDARY_TIME,
    HEALTH_HEARTBEAT_PRIMARY_AMPLITUDE,
    HEALTH_HEARTBEAT_SECONDARY_AMPLITUDE,
    HEALTH_HEARTBEAT_WIDTH,
    PISTOL_ITEM_ID,
    BULLET_ITEM_ID,
    BASEBALL_BAT_ITEM_ID,
    PISTOL_FIRE_RANGE,
    PISTOL_FIRE_COOLDOWN_SECONDS,
    BULLET_DECAL_SIZE,
    BULLET_DECAL_SIZE_VARIANCE,
    BULLET_DECAL_MAX_COUNT,
    PISTOL_RECOIL_RETURN_RATE,
    PISTOL_RECOIL_POSITION_KICK,
    PISTOL_RECOIL_ROTATION_KICK,
    PISTOL_MUZZLE_FLASH_FALLBACK_LOCAL_POSITION,
    PISTOL_MUZZLE_FORWARD_WORLD_OFFSET,
    PISTOL_MUZZLE_FLASH_DURATION,
    PISTOL_PROP_DEBUG_MARKER_LIFETIME,
    MELEE_WEAPON_CONFIG,
    DEBUG_INVENTORY_ITEMS,
    HELD_ITEM_DISPLAY_TUNING,
    ENABLE_HELD_ITEM_TUNING_UI,
    HELD_ITEM_TUNING_SLIDER_DEFS,
    TOP_DOWN_PLAYER_LOOK_LENGTH,
    FLASHLIGHT_RIG_BASE_POSITION,
    FLASHLIGHT_RIG_BASE_ROTATION,
    LEFT_HAND_RIG_BASE_POSITION,
    LEFT_HAND_RIG_BASE_ROTATION,
    LEFT_HAND_ITEM_BASE_ROTATION,
    LEFT_HAND_ITEM_TARGET_SIZE,
    HELD_ITEM_AMBIENT_BOOST_INTENSITY,
    FLASHLIGHT_BOUNCE_DEFAULT_REFLECTANCE,
    collisionOffsets,
  };
}
