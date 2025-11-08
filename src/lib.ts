import { readFile } from "node:fs/promises";
import { redisClientOrPool } from "./client.js";
import packageJson from "../package.json" with { type: "json" };

export const libPrefix = "token_bucket_redis";
export const libVersion = packageJson.version.replaceAll(/\./g, "_");
export const libName = `${libPrefix}_${libVersion}`;
export const libFunctionPrefix = "use_token_bucket";
export const libFunctionName = `${libFunctionPrefix}_${libVersion}`;

export const checkLibIsLoaded = async () => {
  const loadedLibs = await redisClientOrPool.functionList({
    LIBRARYNAME: libName,
  });

  // We could probably just check whether the list is empty or not
  // since we're filtering by the lib's **exact** name, however
  // just to be extra safe...
  const isLoaded = loadedLibs.some((lib) => lib.library_name === libName);

  return isLoaded;
};

export const loadLib = async () => {
  const libPath = new URL(import.meta.resolve("../lua/lib.lua"));
  const libContents = await readFile(libPath, "utf-8");

  await redisClientOrPool.functionLoad(libContents);
};
