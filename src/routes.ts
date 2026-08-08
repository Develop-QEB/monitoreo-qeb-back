import { Router } from 'express'
import { authRouter } from './modules/auth'
import { usersRouter } from './modules/users'
import { auditRouter } from './modules/audit'

export const apiRouter: Router = Router()

apiRouter.use('/auth', authRouter)
apiRouter.use('/users', usersRouter)
apiRouter.use('/audit', auditRouter)
