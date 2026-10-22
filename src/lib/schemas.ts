import { z } from "zod";
import { ROLES } from "./permissions.js";

const email = z.email().max(254).transform((e) => e.toLowerCase());

export const RegisterSchema = z.strictObject({
  email,
  name: z.string().trim().min(1).max(100),
  // Length over complexity rules (NIST SP 800-63B).
  password: z.string().min(12, "password must be at least 12 characters").max(128),
  organization: z.string().trim().min(1).max(100),
});

export const LoginSchema = z.strictObject({ email, password: z.string().min(1).max(128) });
export const RefreshSchema = z.strictObject({ refresh_token: z.string().min(10).max(200) });

export const CreateOrgSchema = z.strictObject({ name: z.string().trim().min(1).max(100) });

export const AddMemberSchema = z.strictObject({
  email,
  role: z.enum(ROLES).exclude(["owner"]).default("member"),
});
export const ChangeRoleSchema = z.strictObject({ role: z.enum(ROLES) });

export const ClientSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: email.nullable().optional(),
});

export const CreateInvoiceSchema = z.strictObject({
  client_id: z.uuid(),
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO code").default("CAD"),
  due_date: z.iso.date().nullable().optional(),
  items: z
    .array(
      z.strictObject({
        description: z.string().trim().min(1).max(500),
        quantity: z.number().int().positive().max(100_000),
        // Money is always integer cents — never floating point.
        unit_price_cents: z.number().int().nonnegative().max(100_000_000),
      }),
    )
    .min(1, "an invoice needs at least one item")
    .max(100),
});

export const InvoiceStatusSchema = z.strictObject({ status: z.enum(["sent", "paid", "void"]) });

export const UuidParam = z.uuid();
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
