import Google from 'next-auth/providers/google'
import type { NextAuthConfig } from 'next-auth'

export const authConfig = {
  trustHost: true,
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
