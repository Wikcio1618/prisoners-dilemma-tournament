import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { signUpProfileSchema } from "@/lib/schemas";

export const POST: APIRoute = async (context) => {
  const form = await context.request.formData();
  const email = form.get("email") as string;
  const password = form.get("password") as string;

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/auth/signup?error=${encodeURIComponent("Supabase is not configured")}`);
  }
  // The display name travels as user metadata, which is where the on_auth_user_created
  // trigger reads it from when it creates the profiles row. If it is missing or invalid the
  // trigger falls back to a pseudonym derived from the user id -- never the email.
  const parsedProfile = signUpProfileSchema.safeParse({ display_name: form.get("display_name") });
  if (!parsedProfile.success) {
    return context.redirect(`/auth/signup?error=${encodeURIComponent("Display name is required (max 40 characters)")}`);
  }

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: parsedProfile.data.display_name } },
  });

  if (error) {
    return context.redirect(`/auth/signup?error=${encodeURIComponent(error.message)}`);
  }

  return context.redirect("/auth/confirm-email");
};
