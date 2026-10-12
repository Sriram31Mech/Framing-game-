/**
 * CC0 model URLs (see assets/licenses/README.md). Missing keys = not available, callers fall
 * back to primitives (area/props.ts). Not available at all: chicken, tractor, bird.
 */
export const MODELS = {
  cropWheat: '/models/crop-wheat.glb',
  cropCorn: '/models/crop-corn.glb',
  cropCarrot: '/models/crop-carrot.glb',
  cropTomato: '/models/crop-tomato.glb',
  cropGeneric: '/models/crop-generic.glb',
  cropRice: '/models/crop-rice.glb',
  tree1: '/models/kk-tree-round.glb',
  tree2: '/models/kk-tree-round-2.glb',
  treeCube: '/models/kk-tree-cube.glb',
  pine: '/models/kk-tree-pine.glb',
  acacia: '/models/kk-tree-acacia.glb',
  palm: '/models/palm.glb',
  bush: '/models/kk-bush.glb',
  bush2: '/models/kk-bush-2.glb',
  rock: '/models/kk-rock.glb',
  rockTall: '/models/kk-rock-tall.glb',
  grass: '/models/kk-grass.glb',
  flowers: '/models/flowers.glb',
  barn: '/models/barn.glb',
  farmhouse: '/models/farmhouse.glb',
  silo: '/models/silo.glb',
  fence: '/models/fence.glb',
  well: '/models/well.glb',
  windmill: '/models/windmill.glb',
  marketStall: '/models/market-stall.glb',
  cow: '/models/cow.glb',
  goat: '/models/goat.glb',
  horse: '/models/horse.glb',
  farmer: '/models/farmer.glb',
  cart: '/models/cart.glb',
  roadStraight: '/models/road-straight.glb',
  houseSmall: '/models/house-small.glb',
  shop: '/models/shop.glb',
} as const satisfies Record<string, string>;

export type ModelKey = keyof typeof MODELS;
