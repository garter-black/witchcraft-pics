import type { MetadataRoute } from "next";

import { SITE_URL } from "@/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      /* /api/blob issues upload tokens — not a page a search result should
         land on. /owner is a private owner sign-in surface and must not be
         discovered or indexed; this is defence-in-depth, not authentication. */
      disallow: ["/api/", "/owner"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
