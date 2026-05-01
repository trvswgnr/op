export interface Tagged<Tag extends string> {
  readonly _tag: Tag;
}

type AbstractCtor = abstract new (...args: readonly never[]) => object;

export type TaggedConstructor<
  Tag extends string,
  Base extends AbstractCtor | undefined,
> = Base extends undefined
  ? new () => Tagged<Tag>
  : Base extends AbstractCtor
    ? new (...args: ConstructorParameters<Base>) => InstanceType<Base> & Tagged<Tag>
    : never;

type TaggedFactory = {
  <Tag extends string>(tag: Tag): TaggedConstructor<Tag, undefined>;
  <Tag extends string, Base extends AbstractCtor>(
    tag: Tag,
    Base: Base,
  ): TaggedConstructor<Tag, Base>;
};

export const Tagged: TaggedFactory = <Tag extends string, Base extends AbstractCtor>(
  tag: Tag,
  Base?: Base,
) => {
  if (Base) {
    // @ts-expect-error 2545: TS can't reconcile `class extends Base`
    // with `ConstructorParameters<Base>` and infers `readonly never[]`
    return class extends Base implements Tagged<Tag> {
      readonly _tag = tag;
    };
  }
  return class implements Tagged<Tag> {
    readonly _tag = tag;
  };
};
