import { constants } from "node:fs";

/** A flag that Windows does not have is missing, although the types say that every flag exists. */
const orZero = (flag: number | undefined): number => flag ?? 0;

/** Opens a file for reading without following a final link and without blocking (a FIFO must not hang the node). */
export const OPEN_READ_NO_FOLLOW = constants.O_RDONLY | orZero(constants.O_NOFOLLOW) | orZero(constants.O_NONBLOCK);
