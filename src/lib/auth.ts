import NextAuth from 'next-auth'
import { checkGroupMembership } from './google-group'
import { authConfig } from './auth.config'

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false
      const isMember = await checkGroupMembership(user.email)
      return isMember
    },
  },
})
