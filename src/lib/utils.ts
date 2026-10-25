import { createCn } from "cn/config";

/**
 * `cn` that knows the design system's type scale. Without this, merging
 * `text-caption` with a color like `text-success` drops the size, because
 * custom `text-*` names look like colors to the merger.
 * Always import `cn` from here, not from the `cn` package.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["metric", "title", "section", "body", "small", "caption"] },
      ],
    },
  },
});
