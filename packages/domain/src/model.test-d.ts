import { describe, expectTypeOf, it } from 'vitest';
import type {
  Department,
  DepartmentId,
  DepartmentOrigin,
  DepartmentTypeId,
  RoleId,
  SkillId,
  Specialist,
  SpecialistConfiguration,
  SpecialistHistoryEvent,
  SpecialistId,
} from './index.js';

describe('D-28 entity model', () => {
  it('keeps specialist, department, role and skill ids distinct', () => {
    expectTypeOf<SpecialistId>().not.toEqualTypeOf<DepartmentId>();
    expectTypeOf<SpecialistId>().not.toEqualTypeOf<SkillId>();
    expectTypeOf<RoleId>().not.toEqualTypeOf<SkillId>();
    expectTypeOf<DepartmentId>().not.toMatchTypeOf<SpecialistId>();
  });

  it('gives each specialist exactly one main role and several skills (D-29)', () => {
    expectTypeOf<SpecialistConfiguration['mainRoleId']>().toEqualTypeOf<RoleId>();
    expectTypeOf<SpecialistConfiguration['enabledSkillIds']>().toEqualTypeOf<readonly SkillId[]>();
  });

  it('separates identity from configuration', () => {
    expectTypeOf<Specialist>().toHaveProperty('identity');
    expectTypeOf<Specialist>().toHaveProperty('configuration');
    expectTypeOf<Specialist['identity']['id']>().toEqualTypeOf<SpecialistId>();
  });

  it('does not fix the list of department types (D-11)', () => {
    // A department type id is an open catalogue id, not a closed union of seven names.
    expectTypeOf<DepartmentTypeId>().toMatchTypeOf<string>();
    expectTypeOf<'marketing'>().not.toMatchTypeOf<DepartmentTypeId>();
    // Companies can have their own custom departments.
    expectTypeOf<{ kind: 'custom'; name: string }>().toMatchTypeOf<DepartmentOrigin>();
    expectTypeOf<Department['origin']>().toEqualTypeOf<DepartmentOrigin>();
  });

  it('records history with a context snapshot on every event', () => {
    expectTypeOf<SpecialistHistoryEvent['context']['roleId']>().toEqualTypeOf<RoleId>();
    expectTypeOf<SpecialistHistoryEvent['type']>().toEqualTypeOf<
      | 'created'
      | 'renamed'
      | 'avatar_changed'
      | 'role_changed'
      | 'skills_changed'
      | 'department_changed'
      | 'paused'
      | 'reactivated'
      | 'archived'
    >();
  });
});
