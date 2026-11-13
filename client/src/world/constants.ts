// Dimensions and pacing of the world. Everything in tiles (TILE px) unless stated otherwise.
import { TILE } from '../art/api';

export { TILE };

/** Width of one building column (one room to the north + one to the south). */
export const COL_W = 16;
/** Height of a room: 2 rows of north wall face + 9 of floor + 1 of south wall. */
export const ROOM_H = 12;
/** Height of the corridor that cuts the building from east to west. */
export const CORRIDOR_H = 5;
/** Core columns (reception/restrooms and kitchen/lounge). */
export const CORE_COLS = 2;

export const NORTH_Y = 0;
export const CORRIDOR_Y = ROOM_H;
export const SOUTH_Y = ROOM_H + CORRIDOR_H;
export const BUILDING_H = ROOM_H * 2 + CORRIDOR_H;

/** First (local) column of the rooms' 2-tile door. */
export const DOOR_X = 7;
export const DOOR_W = 2;

/** Margins of outdoor area around the building (tiles). */
export const EXT_WEST = 20;
export const EXT_EAST = 20;
export const EXT_NORTH = 16;
export const EXT_SOUTH = 24;

/** Speeds in world px per second. */
export const WALK_SPEED = 3.2 * TILE;
export const RUN_SPEED = 6 * TILE;

/** Offset of the feet inside the tile the character is standing on. */
export const FOOT_DX = TILE / 2;
export const FOOT_DY = 11;

/** Allowed zoom (CSS pixels per world pixel). */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 6;

/** Duration of the room animations (ms). */
export const BUILD_MS = 2600;
export const DISMANTLE_MS = 2200;
export const DISMANTLE_DELAY_MS = 1500;
/** A free slot before the last room waits this long before the farthest room moves there. */
export const COMPACT_DELAY_MS = 1200;
/** Debounce for agents that disappear from the snapshot. */
export const MISSING_DEBOUNCE_MS = 3000;
