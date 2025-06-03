import httpStatus from "http-status";
import catchAsync from "../utils/catch-async";
import pick from "../utils/pick";
import { Request, Response } from "express";
import {
  authService,
  userService,
  tokenService,
  organizationService,
  userOrganizationService,
} from "../services";
import logger from "../config/logger";

const register = catchAsync(async (req: Request, res: Response) => {
  const { firstName, lastName, email } = req.body;
  const organization = await organizationService.createOrganization({
    name: `${firstName} ${lastName}'s Organization`,
    email,
    colorTheme: "zinc",
    status: "ACTIVE",
  });

  let user;
  try {
    user = await userService.getUserByEmail(email);

    if (!user) {
      user = await userService.createUser(req.body);

      await userOrganizationService.addUserOrganization({
        userId: user.id,
        organizationId: organization.id,
        isPrimary: true,
        status: "ACTIVE",
        role: "OWNER",
      });
    } else {
      await userOrganizationService.addUserOrganization({
        userId: user.id,
        organizationId: organization.id,
        isPrimary: false,
        status: "ACTIVE",
        role: "OWNER",
      });
    }
  } catch (error: any) {
    await organizationService.deleteOrganization(organization.id);
    logger.error(
      `Something went wrong while registering user. Error: ${error.message}`
    );
  }

  res.status(httpStatus.CREATED).send({
    status: "success",
    message:
      "Your registration was successful. You may now log in to access the application.",
    data: {
      user: pick(user, ["id", "email", "firstName", "lastName"]),
    },
  });
});

const loginUserWithEmailAndPassword = catchAsync(
  async (req: Request, res: Response) => {
    const user = await authService.loginUserWithEmailAndPassword(
      req.body?.email || "",
      req.body?.password
    );

    const { token, expires } = await tokenService.generateAuthTokens(
      user.id,
      user?.organizations[0].organization.id
    );

    res.status(httpStatus.OK).send({
      status: "success",
      message: "Login successful. Welcome back!",
      data: {
        user: pick(user, ["id", "email", "firstName", "lastName"]),
        token,
        expires,
      },
    });
  }
);

export { register, loginUserWithEmailAndPassword };
