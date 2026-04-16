import Google from 'next-auth/providers/google'
import type { NextAuthConfig } from 'next-auth'

export const authConfig = {
  trustHost: true,
  cookies: {
    sessionToken: {
      name: '__Secure-authjs.session-token',
      options: {
        httpOnly: true,
        sameSite: 'none' as const,
        path: '/',
        secure: true,
      },
    },
    callbackUrl: {
      name: '__Secure-authjs.callback-url',
      options: {
        httpOnly: true,
        sameSite: 'none' as const,
        path: '/',
        secure: true,
      },
    },
    csrfToken: {
      name: '__Host-authjs.csrf-token',
      options: {
        httpOnly: true,
        sameSite: 'none' as const,
        path: '/',
        secure: true,
      },
    },
  },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          hd: 'completehomefiltration.com.au',
        },
      },
    }),
  ],
  pages: {
    signIn: '/login',
    error: '/login',
  },
} satisfies NextAuthConfig
