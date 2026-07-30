import { defineMiddleware } from "astro:middleware";
import { createClient } from "@/lib/supabase";

const PROTECTED_ROUTES = ["/dashboard", "/tournaments", "/join"];

export const onRequest = defineMiddleware(async (context, next) => {
  const supabase = createClient(context.request.headers, context.cookies);

  if (supabase) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    context.locals.user = user ?? null;
  } else {
    context.locals.user = null;
  }

  if (PROTECTED_ROUTES.some((route) => context.url.pathname.startsWith(route))) {
    if (!context.locals.user) {
      // Carry the requested path so a shared join link survives sign-in. Only the path and
      // query travel — never the origin — so this cannot become an off-site redirect.
      const next = context.url.pathname + context.url.search;
      return context.redirect(`/auth/signin?next=${encodeURIComponent(next)}`);
    }
  }

  return next();
});
