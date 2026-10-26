/// <reference path="./types.d.ts" />

import tfRouterLanguage from "./src/language/tfRouter";
import deepSeek from "./src/language/deepSeek";
import c2a from "./src/media/c2a";

export type Provider = ProviderDefinition;
export type ProviderPrice = NonNullable<Awaited<ReturnType<NonNullable<Provider["getPrice"]>>>>;
export type ProviderPriceRequest = Parameters<NonNullable<Provider["getPrice"]>>[0];
export type ProviderPriceReference = NonNullable<ProviderPriceRequest["images"]>[number];
export type ProviderBalance = Awaited<ReturnType<NonNullable<Provider["getBalance"]>>>;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [tfRouterLanguage, deepSeek] as const;
export const mediaProviders = [c2a] as const;
