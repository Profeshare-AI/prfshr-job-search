import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";

import { BrandMark } from "@/components/BrandMark";
import { useAuth } from "@/hooks/use-auth";
import { ArrowRight, Loader2, Mail, UserX } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/dashboard",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );
  const [step, setStep] = useState<"signIn" | { email: string }>("signIn");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(redirect);
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);

  const handleEmailSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      setStep({ email: formData.get("email") as string });
      setIsLoading(false);
    } catch (error) {
      console.error("Email sign-in error:", error);
      setError(
        error instanceof Error
          ? error.message
          : "Failed to send verification code. Please try again.",
      );
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      navigate(redirect);
    } catch (error) {
      console.error("OTP verification error:", error);
      setError("The verification code you entered is incorrect.");
      setIsLoading(false);
      setOtp("");
    }
  };

  const handleGuestLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signIn("anonymous");
      navigate(redirect);
    } catch (error) {
      console.error("Guest login error:", error);
      setError(
        `Failed to sign in as guest: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
      setIsLoading(false);
    }
  };

  return (
    <div className="nb-grid flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <Card className="nb-border nb-shadow w-full max-w-[26rem] gap-0 rounded-none bg-card p-0 shadow-none">
        {step === "signIn" ? (
          <>
            <CardHeader className="gap-4 px-7 pt-7 pb-5 text-center">
              <div className="flex justify-center">
                <BrandMark to="/" showDescriptor={false} />
              </div>
              <div className="space-y-2">
                <CardTitle className="font-display text-2xl leading-none tracking-tight">
                  Sign in to reach the workspace
                </CardTitle>
                <CardDescription className="text-balance">
                  Enter your email and we&apos;ll send a one-time code — no
                  password to remember.
                </CardDescription>
              </div>
            </CardHeader>
            <form onSubmit={handleEmailSubmit}>
              <CardContent className="space-y-5 px-7 pt-0 pb-7">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-nb-line/55" />
                    <Input
                      name="email"
                      placeholder="name@example.com"
                      type="email"
                      className="h-11 rounded-none border-2 border-nb-line bg-nb-surface2 pl-9 text-nb-line shadow-none placeholder:text-nb-line/45 focus-visible:border-nb-amber focus-visible:ring-0"
                      disabled={isLoading}
                      required
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="outline"
                    size="icon-lg"
                    aria-label="Send the verification code"
                    className="nb-border nb-press h-11 w-11 rounded-none bg-nb-amber text-nb-deep shadow-none hover:bg-nb-surface hover:text-nb-line"
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ArrowRight className="size-4" />
                    )}
                  </Button>
                </div>

                {error && (
                  <p className="text-xs font-semibold text-nb-red">{error}</p>
                )}

                <div>
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t-2 border-nb-line/15" />
                    </div>
                    <div className="relative flex justify-center">
                      <span className="bg-card px-2 font-mono text-[10px] tracking-[0.18em] text-nb-line/50 uppercase">
                        Or
                      </span>
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    className="nb-border nb-press mt-5 h-11 w-full rounded-none bg-nb-surface text-nb-line shadow-none hover:bg-nb-amber hover:text-nb-deep"
                    onClick={handleGuestLogin}
                    disabled={isLoading}
                  >
                    <UserX className="size-4" />
                    Continue as a guest
                  </Button>
                </div>
              </CardContent>
            </form>
          </>
        ) : (
          <>
            <CardHeader className="gap-4 px-7 pt-7 pb-5 text-center">
              <div className="flex justify-center">
                <BrandMark to="/" showDescriptor={false} />
              </div>
              <div className="space-y-2">
                <CardTitle className="font-display text-2xl leading-none tracking-tight uppercase">
                  Check your email
                </CardTitle>
                <CardDescription className="text-balance">
                  We&apos;ve sent a code to{" "}
                  <span className="font-semibold text-nb-line">{step.email}</span>
                </CardDescription>
              </div>
            </CardHeader>
            <form onSubmit={handleOtpSubmit}>
              <CardContent className="space-y-4 px-7 pt-0 pb-5">
                <input type="hidden" name="email" value={step.email} />
                <input type="hidden" name="code" value={otp} />

                <div className="flex justify-center">
                  <InputOTP
                    value={otp}
                    onChange={setOtp}
                    maxLength={6}
                    disabled={isLoading}
                    containerClassName="justify-center"
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        otp.length === 6 &&
                        !isLoading
                      ) {
                        const form = (e.target as HTMLElement).closest("form");
                        form?.requestSubmit();
                      }
                    }}
                  >
                    <InputOTPGroup className="gap-1.5 sm:gap-2">
                      {Array.from({ length: 6 }).map((_, index) => (
                        <InputOTPSlot
                          key={index}
                          index={index}
                          className="nb-border size-9 rounded-none bg-nb-surface2! text-base font-semibold text-nb-line shadow-none! data-[active=true]:bg-nb-amber! data-[active=true]:text-nb-deep! data-[active=true]:ring-0! sm:size-11"
                        />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>

                {error && (
                  <p className="text-center text-xs font-semibold text-nb-red">
                    {error}
                  </p>
                )}

                <p className="text-center text-sm text-muted-foreground">
                  Didn&apos;t get a code?{" "}
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0"
                    onClick={() => setStep("signIn")}
                  >
                    Try again
                  </Button>
                </p>
              </CardContent>
              <CardFooter className="flex-col gap-2.5 px-7 pt-0 pb-7">
                <Button
                  type="submit"
                  className="nb-border nb-press h-11 w-full rounded-none bg-nb-amber font-display text-xs tracking-[0.14em] text-nb-deep uppercase shadow-none hover:bg-nb-line"
                  disabled={isLoading || otp.length !== 6}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    <>
                      Verify code
                      <ArrowRight className="size-4" />
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setStep("signIn")}
                  disabled={isLoading}
                  className="h-10 w-full rounded-none text-nb-line/60 hover:bg-nb-surface2 hover:text-nb-line"
                >
                  Use different email
                </Button>
              </CardFooter>
            </form>
          </>
        )}
      </Card>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
