/**
 * A channel's icon: a squircle tile with the channel's first letter and a thin red base line. Channels have no uploaded
 * picture yet, so the letter stands in for one.
 */
export function ChannelAvatar({ name, size = 'md' }: { name: string; size?: 'xs' | 'sm' | 'md' | 'lg' }): JSX.Element {
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span className={`channel-avatar ${size}`} aria-hidden="true">
      <span className="channel-avatar-letter">{letter}</span>
    </span>
  );
}
