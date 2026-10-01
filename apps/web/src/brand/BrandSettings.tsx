import { FormattedMessage } from '@melonoffice/i18n';
import { PageHeader, StateMessage } from '@melonoffice/ui';
import { useEffect, useState } from 'react';
import type { OwnBrand } from '../commercial/consoleClient.js';
import { BrandForm } from './BrandForm.js';
import type { OrganizationBrandClient } from './organizationBrand.js';

/**
 * The owner's brand screen (ADR-0090): the organization's own level. Without `brand.manage` it is
 * shown and not changed. A partner's white-label level, when there is one, still comes after it.
 */
export function BrandSettings({
  client,
  canEdit,
  onSaved,
}: {
  readonly client: OrganizationBrandClient;
  readonly canEdit: boolean;
  /** Called after a save, so the app shows the new brand. */
  readonly onSaved: () => void;
}) {
  const [brand, setBrand] = useState<OwnBrand | 'loading' | 'error'>('loading');
  useEffect(() => {
    let live = true;
    client.read().then(
      (b) => live && setBrand(b),
      () => live && setBrand('error'),
    );
    return () => {
      live = false;
    };
  }, [client]);

  return (
    <article className="mo-page brand-page">
      <PageHeader
        title={<FormattedMessage id="brand.title" />}
        description={<FormattedMessage id="brand.lead" />}
      />
      {brand === 'loading' ? null : brand === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="console.error" />
        </StateMessage>
      ) : (
        <div className="mo-panel">
          <BrandForm
            brand={brand}
            canEdit={canEdit}
            onSave={async (config) => {
              const saved = await client.save(config, brand.updatedAt);
              setBrand(saved);
              onSaved();
              return saved;
            }}
          />
        </div>
      )}
    </article>
  );
}
