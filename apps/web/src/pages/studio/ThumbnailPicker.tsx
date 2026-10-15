import { useEffect, useId, useRef, useState } from 'react';

export const THUMBNAIL_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const THUMBNAIL_MAX_MB = 5;

export function checkImage(file: File): string | null {
  if (!THUMBNAIL_TYPES.includes(file.type)) return 'Choose a JPEG, PNG or WebP image.';
  if (file.size === 0) return 'That image is empty.';
  if (file.size > THUMBNAIL_MAX_MB * 1024 * 1024) return `That image is larger than ${THUMBNAIL_MAX_MB} MB.`;
  return null;
}

/**
 * Lets a creator choose their own thumbnail. `current` is what is shown when nothing is chosen (the existing
 * thumbnail, or a frame from the video); choosing nothing keeps the automatic one.
 */
export function ThumbnailPicker({
  file,
  onChange,
  current,
  disabled,
  hint = 'Optional. Without one, a frame from the video is used.',
}: {
  file: File | null;
  onChange(file: File | null): void;
  current?: string | null;
  disabled?: boolean;
  hint?: string;
}): JSX.Element {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosenUrl, setChosenUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return setChosenUrl(null);
    const url = URL.createObjectURL(file);
    setChosenUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pick = (f: File | undefined): void => {
    if (inputRef.current) inputRef.current.value = '';
    if (!f) return;
    const problem = checkImage(f);
    setError(problem);
    if (!problem) onChange(f);
  };

  const shown = chosenUrl ?? current ?? null;
  return (
    <div className="field thumb-picker">
      <label htmlFor={`${id}-file`}>Thumbnail</label>
      <div className="thumb-picker-row">
        <div className="thumb-picker-frame">{shown ? <img src={shown} alt={file ? 'Chosen thumbnail' : 'Current thumbnail'} /> : <span className="muted small">No picture yet</span>}</div>
        <div className="thumb-picker-actions">
          <button type="button" className="btn small" onClick={() => inputRef.current?.click()} disabled={disabled}>
            {file || current ? 'Choose a different image' : 'Choose image'}
          </button>
          {file ? (
            <button type="button" className="btn small" onClick={() => onChange(null)} disabled={disabled}>
              Don’t use this image
            </button>
          ) : null}
          <p className="muted small">{hint} JPEG, PNG or WebP, up to {THUMBNAIL_MAX_MB} MB. 16:9 looks best.</p>
        </div>
      </div>
      <input ref={inputRef} id={`${id}-file`} type="file" accept={THUMBNAIL_TYPES.join(',')} className="sr-only" tabIndex={-1} onChange={(e) => pick(e.target.files?.[0])} />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
