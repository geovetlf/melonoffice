import { useId, type ElementType, type ReactNode } from 'react';

/** A part of a form with a title and a line that says what it is for, above its fields. */
export function FormSection({
  title,
  titleAs: Title = 'h2',
  description,
  children,
  className,
}: {
  readonly title: ReactNode;
  readonly titleAs?: ElementType;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const id = useId();
  return (
    <section
      className={className === undefined ? 'mo-form-section' : `mo-form-section ${className}`}
      aria-labelledby={id}
    >
      <div className="mo-form-section__header">
        <Title id={id} className="mo-form-section__title">
          {title}
        </Title>
        {description === undefined ? null : (
          <p className="mo-form-section__description">{description}</p>
        )}
      </div>
      <div className="mo-form-section__fields">{children}</div>
    </section>
  );
}
