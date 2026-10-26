import { AuthProvider } from '@payloadcms/ui';
import { render } from 'vitest-browser-react';
import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';

import { AccessAvatar } from './index.js';

// `@payloadcms/ui` の AuthProvider / useAuth と DefaultAccountIcon は vitest では stub(src/__mocks__, vitest.config.ts の alias)。
const PICTURE = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="96" height="96"/%3E';

const userWith = (avatarURL: unknown) => ({ id: 1, collection: 'users', email: 'napo@example.com', avatarURL });

const userWithPicture = { ...userWith(''), picture: PICTURE };

describe('AccessAvatar', () => {
  it('shows the image stored in the configured field', async () => {
    const screen = await render(
      <AuthProvider user={userWith(PICTURE)}>
        <AccessAvatar field="avatarURL" />
      </AuthProvider>,
    );

    const image = screen.container.querySelector('img');
    expect(image?.getAttribute('src')).toBe(PICTURE);
    await expect.element(page.getByTestId('payload-default-avatar')).not.toBeInTheDocument();
  });

  // AppHeader の Link が aria-label を持つので装飾扱いで alt は空。Payload の Gravatar と同じ 25px の丸。
  it('is decorative and sized like the Payload avatar', async () => {
    const screen = await render(
      <AuthProvider user={userWith(PICTURE)}>
        <AccessAvatar field="avatarURL" />
      </AuthProvider>,
    );

    const image = screen.container.querySelector('img');
    expect(image?.getAttribute('alt')).toBe('');
    expect(image?.getAttribute('width')).toBe('25');
    expect(image?.getAttribute('height')).toBe('25');
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');
    await expect.poll(() => (image === null ? '' : getComputedStyle(image).borderTopLeftRadius)).toBe('50%');
  });

  it.each([
    { name: 'an empty value', user: userWith('') },
    { name: 'a whitespace value', user: userWith('  ') },
    { name: 'a non-string value', user: userWith(42) },
    { name: 'a missing field', user: { id: 1, collection: 'users', email: 'napo@example.com' } },
    { name: 'no user', user: null },
  ])('falls back to the Payload default avatar for $name', async ({ user }) => {
    const screen = await render(
      <AuthProvider user={user}>
        <AccessAvatar field="avatarURL" />
      </AuthProvider>,
    );

    await expect.element(page.getByTestId('payload-default-avatar')).toBeInTheDocument();
    expect(screen.container.querySelector('img')).toBeNull();
  });

  it('reads the field it is given', async () => {
    const screen = await render(
      <AuthProvider user={userWithPicture}>
        <AccessAvatar field="picture" />
      </AuthProvider>,
    );

    expect(screen.container.querySelector('img')?.getAttribute('src')).toBe(PICTURE);
  });
});
