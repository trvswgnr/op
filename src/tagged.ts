export interface Tagged<Tag extends string> {
  readonly _tag: Tag;
}

type AbstractCtor = abstract new (...args: readonly never[]) => unknown;

export interface TaggedConstructor<Ctor extends AbstractCtor, Tag extends string> {
  new (...args: ConstructorParameters<Ctor>): InstanceType<Ctor> & Tagged<Tag>;
}

export const Tagged = <Base extends AbstractCtor, Tag extends string>(
  Base: Base,
  tag: Tag,
): TaggedConstructor<Base, Tag> => {
  // @ts-expect-error TS2322 + TS2509:
  // - TS can't reconcile `class extends Ctor` with `ConstructorParameters<Ctor>` and infers `readonly never[]`.
  // - `Ctor` returns `unknown`, so TS can't prove the base instance is an object for `implements Tagged<Tag>`.
  return class extends Base implements Tagged<Tag> {
    readonly _tag = tag;
  };
};
