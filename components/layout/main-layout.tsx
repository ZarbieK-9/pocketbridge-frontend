import type React from "react";
/**
 * Main layout wrapper with collapsible sidebar
 */

import { Sidebar } from "./sidebar"
import { SidebarProvider, useSidebar } from "./sidebar-context"
import { cn } from "@/lib/utils"

interface MainLayoutProps {
  children: React.ReactNode
}

function MainContent({ children }: MainLayoutProps) {
  const { isCollapsed } = useSidebar()

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main
        className={cn(
          "h-screen transition-[margin] duration-300 ease-in-out",
          isCollapsed ? "ml-16" : "ml-64"
        )}
        role="main"
        aria-label="Main content"
        id="main-content"
      >
        {children}
      </main>
      {/* Skip to main content link for keyboard navigation */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-md"
        onClick={(e) => {
          e.preventDefault();
          const main = document.getElementById('main-content');
          if (main) {
            main.focus();
            main.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }}
      >
        Skip to main content
      </a>
    </div>
  )
}

export function MainLayout({ children }: MainLayoutProps) {
  return (
    <SidebarProvider>
      <MainContent>{children}</MainContent>
    </SidebarProvider>
  )
}
