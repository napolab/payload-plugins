import { parseAudiences } from '@napolab/cloudflare-access-core/audiences';
import { AccessLogoutEndpointsDisabled, AccessTargetCollectionNotFound } from '../errors/index.js';
import { ACCESS_LOGOUT_ENDPOINT_PATH, createAccessLogoutEndpoint } from '../logout-endpoint/index.js';
import { rejectPasswordWrites } from '../password-guard/index.js';
import { createAccessStrategy } from '../strategy/index.js';
import type { AccessStrategyProfileOptions } from '../strategy/index.js';
import type { AccessProfileMapper } from '../profile-sync/index.js';
import type { AccessUserData } from '../resolve-user/index.js';
import { fetchAccessProfile } from '@napolab/cloudflare-access-core/identity';
import { normalizeTeamDomain } from '@napolab/cloudflare-access-core/team-domain';
import { createAccessKeys } from '@napolab/cloudflare-access-core/verify';

import type { AuthStrategy, CollectionConfig, Config, Endpoint, Plugin, TypedUser } from 'payload';

export const ACCESS_LOGOUT_BUTTON_PATH = '@napolab/payload-cloudflare-access/client/logout-button#LogoutButton';

export const ACCESS_AVATAR_PATH = '@napolab/payload-cloudflare-access/client/access-avatar#AccessAvatar';

export type CloudflareAccessProfileOptions = {
  // AccessProfile -> user doc に書くデータ(作成時と、Access のセッションごとの更新)。自分で持つフィールドだけ返す。
  map: AccessProfileMapper;
  // アバター画像の URL を入れている user doc のフィールド名。指定すると admin.avatar にその画像を出す。
  avatarField?: Extract<keyof AccessUserData, string>;
};

export type CloudflareAccessPluginOptions = {
  teamDomain: string | undefined;
  aud: string | undefined;
  collection?: string;
  profile?: CloudflareAccessProfileOptions;
};

type EnabledOptions = { teamDomain: string; aud: readonly string[] };

// 片方でも空なら無効(throw しない)。team 名は AUD より先に設定されるのが普通なので、無効な間の
// typo で config 評価(= サイト全体と Payload CLI)を落とさない。teamDomain の検証は有効化する時だけで、
// 不正な値は InvalidAccessTeamDomain を throw する(誤った team で有効化すると全員締め出しになる)。
const resolveEnabledOptions = (options: CloudflareAccessPluginOptions): EnabledOptions | undefined => {
  if (options.aud === undefined) return undefined;
  if ((options.teamDomain ?? '').trim() === '') return undefined;

  const aud = parseAudiences(options.aud);
  if (aud.length === 0) return undefined;

  const teamDomain = normalizeTeamDomain(options.teamDomain);
  if (teamDomain === undefined) return undefined;

  return { teamDomain, aud };
};

const isAuthCollection = (collection: CollectionConfig): boolean => collection.auth !== undefined && collection.auth !== false;

// Payload の結果型は `TypedUser['collection']` を要求するが、config 上の slug は string。
// 型は実行時に絞れないので、少なくとも config 上に存在する auth collection であることを確かめてから絞る。
const isAuthCollectionSlug = (slug: string, collections: readonly CollectionConfig[]): slug is TypedUser['collection'] =>
  collections.some((collection) => collection.slug === slug && isAuthCollection(collection));

// `false` は collection の REST を全部止める指定。endpoint を足すと Payload の sanitize が既定の REST まで
// 戻してしまう(collections/config/sanitize.js は `endpoints !== false` なら既定を push する)ので、黙って足さずに throw する。
const withEndpoint = (collection: CollectionConfig, endpoint: Endpoint): CollectionConfig['endpoints'] => {
  if (collection.endpoints === false) throw new AccessLogoutEndpointsDisabled(collection.slug);

  return [...(collection.endpoints ?? []), endpoint];
};

type AccessAuthParts = { strategy: AuthStrategy; logoutEndpoint: Endpoint };

const withAccessAuth = (collection: CollectionConfig, { strategy, logoutEndpoint }: AccessAuthParts): CollectionConfig => {
  const auth = typeof collection.auth === 'object' ? collection.auth : {};

  return {
    ...collection,
    auth: {
      ...auth,
      strategies: [...(auth.strategies ?? []), strategy],
      disableLocalStrategy: { enableFields: true },
    },
    hooks: {
      ...collection.hooks,
      // 既存の beforeOperation より先に置く。後ろの hook が args を差し替えても拒否が先に効く。
      beforeOperation: [rejectPasswordWrites, ...(collection.hooks?.beforeOperation ?? [])],
    },
    endpoints: withEndpoint(collection, logoutEndpoint),
  };
};

// 対象は `options.collection` -> `admin.user` -> 最初の auth collection(Payload の sanitize と同じ既定)の順。
// Access の env が設定済みなのに対象が解決できない場合は throw する。黙って無効にすると password ログインが残る(fail-open)。
const resolveTargetSlug = (options: CloudflareAccessPluginOptions, config: Config): TypedUser['collection'] => {
  const collections = config.collections ?? [];
  const slug = options.collection ?? config.admin?.user ?? collections.find(isAuthCollection)?.slug;
  if (slug === undefined || !isAuthCollectionSlug(slug, collections)) throw new AccessTargetCollectionNotFound(slug);

  return slug;
};

// 本番は get-identity を素の fetch で取る(差し替えは strategy のテストだけ)。
const toStrategyProfile = (profile: CloudflareAccessProfileOptions | undefined): AccessStrategyProfileOptions | undefined =>
  profile === undefined ? undefined : { map: profile.map, fetchProfile: fetchAccessProfile };

const enableAccessAuth = (config: Config, enabled: EnabledOptions, target: TypedUser['collection'], profile: CloudflareAccessProfileOptions | undefined): Config => {
  // JWKS は 1 回だけ作る(jose がキャッシュを持つ)。
  const parts: AccessAuthParts = {
    strategy: createAccessStrategy({ ...enabled, collection: target, keys: createAccessKeys(enabled.teamDomain), profile: toStrategyProfile(profile) }),
    logoutEndpoint: createAccessLogoutEndpoint(target),
  };

  return {
    ...config,
    collections: (config.collections ?? []).map((collection) => (collection.slug === target ? withAccessAuth(collection, parts) : collection)),
  };
};

// Payload の REST は `routes.api`(既定 `/api`)の下に `/<slug>/<endpoint path>` で出る。
const accessLogoutActionFor = (config: Config, target: TypedUser['collection']): string => `${config.routes?.api ?? '/api'}/${target}${ACCESS_LOGOUT_ENDPOINT_PATH}`;

// Button は env に関わらず登録する(importMap に載るものを env で分岐させない)。無効なら action は null で、
// Button は Payload 既定の Logout を描く。
const withLogoutButton = (config: Config, accessLogoutAction: string | null): Config => ({
  ...config,
  admin: {
    ...config.admin,
    components: {
      ...config.admin?.components,
      logout: {
        ...config.admin?.components?.logout,
        Button: {
          path: ACCESS_LOGOUT_BUTTON_PATH,
          clientProps: { accessLogoutAction },
        },
      },
    },
  },
});

// avatarField がある時だけ admin.avatar を差し替える。Logout と同じく env には依存させない。
const withAvatar = (config: Config, avatarField: string | undefined): Config => {
  if (avatarField === undefined) return config;

  return {
    ...config,
    admin: {
      ...config.admin,
      avatar: { Component: { path: ACCESS_AVATAR_PATH, clientProps: { field: avatarField } } },
    },
  };
};

const applyAccess = (options: CloudflareAccessPluginOptions, config: Config): Config => {
  const enabledOptions = resolveEnabledOptions(options);
  if (enabledOptions === undefined) return withLogoutButton(config, null);

  const target = resolveTargetSlug(options, config);
  return withLogoutButton(enableAccessAuth(config, enabledOptions, target, options.profile), accessLogoutActionFor(config, target));
};

export const cloudflareAccessPlugin =
  (options: CloudflareAccessPluginOptions): Plugin =>
  (config: Config): Config =>
    withAvatar(applyAccess(options, config), options.profile?.avatarField);
