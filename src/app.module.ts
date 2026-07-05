import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { MailerModule } from './mailer/mailer.module';
import { DealersModule } from './dealers/dealers.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { ProductsModule } from './products/products.module';
import { CategoriesModule } from './categories/categories.module';
import { InventoryModule } from './inventory/inventory.module';
import { PurchasesModule } from './purchases/purchases.module';
import { OrdersModule } from './orders/orders.module';
import { InvoicesModule } from './invoices/invoices.module';
import { PaymentsModule } from './payments/payments.module';
import { ActivityLogModule } from './activity-log/activity-log.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { InvestorsModule } from './investors/investors.module';
import { InvestmentsModule } from './investments/investments.module';
import { ExpensesModule } from './expenses/expenses.module';
import { EquityModule } from './equity/equity.module';
import { SalesReturnsModule } from './sales-returns/sales-returns.module';
import { PurchaseReturnsModule } from './purchase-returns/purchase-returns.module';
import { CreditsModule } from './credits/credits.module';
import { SalesAnalysisModule } from './sales-analysis/sales-analysis.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    MailerModule,
    AuthModule,
    DealersModule,
    SuppliersModule,
    ProductsModule,
    CategoriesModule,
    InventoryModule,
    PurchasesModule,
    OrdersModule,
    InvoicesModule,
    PaymentsModule,
    ActivityLogModule,
    DashboardModule,
    InvestorsModule,
    InvestmentsModule,
    ExpensesModule,
    EquityModule,
    SalesReturnsModule,
    PurchaseReturnsModule,
    CreditsModule,
    SalesAnalysisModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
