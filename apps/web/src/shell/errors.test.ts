import { describe, expect, it } from 'vitest';
import { AgentRequestError } from '../agents/agentsClient.js';
import { CustomerRequestError } from '../customers/customersClient.js';
import { MemoryRequestError } from '../memory/memoryClient.js';
import { errorCode, errorMessage } from './errors.js';

describe('errorCode', () => {
  const known: ReadonlySet<string> = new Set(['permission_denied', 'specialist_archived']);

  it('keeps a code the page explains', () => {
    expect(
      errorCode(new AgentRequestError(403, 'permission_denied'), AgentRequestError, known),
    ).toBe('permission_denied');
  });

  it('says generic for an unknown code, no code, another class or anything else', () => {
    expect(errorCode(new AgentRequestError(500, 'internal'), AgentRequestError, known)).toBe(
      'generic',
    );
    expect(errorCode(new AgentRequestError(500), AgentRequestError, known)).toBe('generic');
    expect(
      errorCode(
        new MemoryRequestError(403, 'permission_denied', undefined),
        AgentRequestError,
        known,
      ),
    ).toBe('generic');
    expect(errorCode(new TypeError('offline'), AgentRequestError, known)).toBe('generic');
    expect(errorCode(undefined, AgentRequestError, known)).toBe('generic');
  });
});

describe('errorMessage', () => {
  it('names the message for the code under the page’s prefix', () => {
    expect(
      errorMessage(
        new CustomerRequestError(409, 'contact_exists', undefined, undefined),
        CustomerRequestError,
        'customers',
      ),
    ).toBe('customers.error.contact_exists');
  });

  it('falls back to the page’s generic message', () => {
    expect(
      errorMessage(
        new CustomerRequestError(500, undefined, undefined, undefined),
        CustomerRequestError,
        'customers',
      ),
    ).toBe('customers.error.generic');
    expect(errorMessage(new Error('x'), CustomerRequestError, 'customers')).toBe(
      'customers.error.generic',
    );
  });
});
