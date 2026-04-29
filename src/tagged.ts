export interface Tagged<Tag extends string> {
  readonly _tag: Tag;
}

type AbstractCtor = abstract new (...args: readonly never[]) => unknown;

export interface TaggedConstructor<Ctor extends AbstractCtor, Tag extends string> {
  new (...args: ConstructorParameters<Ctor>): InstanceType<Ctor> & Tagged<Tag>;
}

export const Tagged = <Ctor extends AbstractCtor, Tag extends string>(
  Ctor: Ctor,
  tag: Tag,
): TaggedConstructor<Ctor, Tag> => {
  // @ts-expect-error - ts doesn't understand
  return class extends Ctor implements Tagged<Tag> {
    readonly _tag = tag;
  };
};
