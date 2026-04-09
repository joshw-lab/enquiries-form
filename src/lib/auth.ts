import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'
import { checkGroupMembership } from './google-group'

export const { handlers, signIn, signOut, auth } = NextAuth({
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
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false
      const isMember = await checkGroupMembership(user.email)
      return isMember
    },
  },
  pages: {
    signIn: '/reports/login',
    error: '/reports/login',
  },
})
