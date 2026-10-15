import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ThumbnailPicker, checkImage } from './ThumbnailPicker';

const image = (name: string, type: string, bytes = 10): File => new File([new Uint8Array(bytes)], name, { type });

function Harness({ current }: { current?: string }) {
  const [file, setFile] = useState<File | null>(null);
  return (
    <>
      <ThumbnailPicker file={file} onChange={setFile} current={current ?? null} />
      <output>{file ? file.name : 'automatic'}</output>
    </>
  );
}

describe('thumbnail picker', () => {
  it('accepts JPEG, PNG and WebP up to 5 MB only', () => {
    expect(checkImage(image('a.jpg', 'image/jpeg'))).toBeNull();
    expect(checkImage(image('a.webp', 'image/webp'))).toBeNull();
    expect(checkImage(image('a.gif', 'image/gif'))).toMatch(/JPEG, PNG or WebP/);
    expect(checkImage(image('a.png', 'image/png', 0))).toMatch(/empty/);
    expect(checkImage(image('a.png', 'image/png', 5 * 1024 * 1024 + 1))).toMatch(/larger than 5 MB/);
  });

  it('shows the current picture, takes a chosen one, refuses others and can go back to automatic', async () => {
    const u = userEvent.setup();
    render(<Harness current="/api/v1/videos/v1/thumbnail" />);
    expect(screen.getByAltText('Current thumbnail').getAttribute('src')).toBe('/api/v1/videos/v1/thumbnail');
    const input = screen.getByLabelText('Thumbnail') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [image('anim.gif', 'image/gif')] } });
    expect(screen.getByRole('alert').textContent).toMatch(/JPEG, PNG or WebP/);
    expect(screen.getByRole('status').textContent).toBe('automatic');

    fireEvent.change(input, { target: { files: [image('cover.png', 'image/png')] } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('cover.png');
    expect(screen.getByAltText('Chosen thumbnail')).toBeTruthy();

    await u.click(screen.getByRole('button', { name: 'Don’t use this image' }));
    expect(screen.getByRole('status').textContent).toBe('automatic');
    expect(screen.getByAltText('Current thumbnail')).toBeTruthy();
  });
});
