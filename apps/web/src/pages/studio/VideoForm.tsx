import { useState, type ReactNode } from 'react';
import { MAX_RATE_PER_MINUTE_STRM, MAX_TAGS, MAX_VIDEO_TITLE, parseSTRM, weiToString } from '@tesor_gp/shared';
import { Field } from '../../components/Field';
import { getMoneyFormat, isBankMode, moneyUnit } from '../../lib/format';
import { formatSTRM } from '@tesor_gp/shared';

export interface VideoFormValues {
  title: string;
  description: string;
  category: string;
  tags: string;
  /** Rate per minute watched, as typed. */
  rate: string;
}

export function validateVideoForm(v: VideoFormValues, maxRate = MAX_RATE_PER_MINUTE_STRM): { errors: Record<string, string>; rateWei?: string; tags?: string[] } {
  const errors: Record<string, string> = {};
  if (!v.title.trim()) errors.title = 'Give your video a title';
  else if (v.title.trim().length > MAX_VIDEO_TITLE) errors.title = `Title must be ${MAX_VIDEO_TITLE} characters or fewer`;
  let rateWei: string | undefined;
  const rate = v.rate.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(rate)) errors.rate = 'Enter a rate like 2 (or 0 for free)';
  else {
    const wei = parseSTRM(rate);
    if (wei > parseSTRM(String(maxRate))) errors.rate = isBankMode() ? `The rate can be at most ${getMoneyFormat().symbol}${maxRate} per minute` : `The rate can be at most ${maxRate} STRM per minute`;
    else rateWei = weiToString(wei);
  }
  const tags = v.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length > MAX_TAGS) errors.tags = `Use at most ${MAX_TAGS} tags`;
  const out: { errors: Record<string, string>; rateWei?: string; tags?: string[] } = { errors, tags };
  if (rateWei !== undefined) out.rateWei = rateWei;
  return out;
}

export function weiToPriceInput(wei: string): string {
  return formatSTRM(BigInt(wei || '0'), 18);
}

export function VideoFields({
  values,
  onChange,
  errors,
  categories,
  children,
  hideRate = false,
}: {
  values: VideoFormValues;
  onChange(v: VideoFormValues): void;
  errors: Record<string, string>;
  categories: string[];
  children?: ReactNode;
  /** Live streams are sold by one price instead of a rate per minute. */
  hideRate?: boolean;
}): JSX.Element {
  const [touched] = useState(false);
  void touched;
  const set = (k: keyof VideoFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => onChange({ ...values, [k]: e.target.value });
  return (
    <>
      <Field label="Title" value={values.title} onChange={set('title')} error={errors.title} maxLength={MAX_VIDEO_TITLE} />
      <div className="field">
        <label htmlFor="vf-desc">Description</label>
        <textarea id="vf-desc" rows={4} value={values.description} onChange={set('description')} maxLength={5000} />
      </div>
      <div className="field">
        <label htmlFor="vf-cat">Category</label>
        <select id="vf-cat" value={values.category} onChange={set('category')}>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <Field label="Tags" value={values.tags} onChange={set('tags')} error={errors.tags} hint="Comma separated, up to 10" />
      {hideRate ? null : <Field
        label={`Rate per minute (${moneyUnit()})`}
        inputMode="decimal"
        value={values.rate}
        onChange={set('rate')}
        error={errors.rate}
        hint={`Viewers pay this per minute, charged by the second they actually watch. Rewatching is free and skipped parts are never charged. 0 makes the video free. Maximum ${MAX_RATE_PER_MINUTE_STRM}.`}
      />}
      {children}
    </>
  );
}
