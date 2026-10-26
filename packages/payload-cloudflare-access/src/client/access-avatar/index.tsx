'use client';

import { useAuth } from '@payloadcms/ui';
import { DefaultAccountIcon } from '@payloadcms/ui/graphics/Account/Default';

import styles from './styles.module.css';

import type { ReactElement } from 'react';

export type AccessAvatarProps = {
  // アバター画像の URL を持つ user doc のフィールド名(plugin の profile.avatarField)。
  field: string;
};

// Payload の Gravatar と同じ大きさ。
const AVATAR_SIZE = 25;

const readAvatarURL = (user: unknown, field: string): string | undefined => {
  if (typeof user !== 'object' || user === null || !Object.hasOwn(user, field)) return undefined;

  const value: unknown = Reflect.get(user, field);
  if (typeof value !== 'string' || value.trim() === '') return undefined;

  return value;
};

// `admin.avatar` に object を渡すと Payload の Account は何も描かないので、空の時は既定のアイコンを自分で出す。
// active(アカウントページ上での強調)は next/navigation に依存させないため付けない。
export const AccessAvatar = ({ field }: AccessAvatarProps): ReactElement => {
  const { user } = useAuth();
  const src = readAvatarURL(user, field);
  if (src === undefined) return <DefaultAccountIcon active={false} />;

  // 包んでいる AppHeader の Link が aria-label(Account)を持つので画像は装飾扱いで alt は空。
  // Google のプロフィール画像は Referer 付きだと弾かれることがある。
  return <img alt="" className={styles.avatar} height={AVATAR_SIZE} referrerPolicy="no-referrer" src={src} width={AVATAR_SIZE} />;
};
