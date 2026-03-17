import React from 'react';

export interface AppShellLayoutProps {
  leftSidebar?: React.ReactNode;
  rightSidebar?: React.ReactNode;
  mainContent: React.ReactNode;
  commandArea?: React.ReactNode;
  hideCommandArea?: boolean; // For when settings view is active
}

export const AppShellLayout: React.FC<AppShellLayoutProps> = ({
  leftSidebar,
  rightSidebar,
  mainContent,
  commandArea,
  hideCommandArea = false,
}) => {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg text-text-main flex font-sans">
      
      {/* LEFT SIDEBAR */}
      {leftSidebar && (
        <div className="group/left z-40 absolute inset-y-0 left-0 flex">
          <div className="w-10 h-full flex items-center justify-start pl-2.5 cursor-pointer peer">
            <div className="text-text-muted transition-all duration-300 group-hover/left:text-primary group-hover/left:scale-110 pointer-events-none">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>
            </div>
          </div>
          {/* Drawer */}
          <div className="absolute top-0 left-[-340px] w-[320px] max-w-[85vw] h-full bg-bg/80 backdrop-blur-[40px] border-r border-border p-10 z-50 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] shadow-[20px_0_50px_rgba(0,0,0,0.3)] peer-hover:left-0 hover:left-0 flex flex-col">
            {leftSidebar}
          </div>
        </div>
      )}

      {/* MAIN CONTENT AREA */}
      <div className="flex-1 flex flex-col relative w-full h-full">
         <main className="flex-1 overflow-hidden relative">
           {mainContent}
         </main>
         
         {/* COMMAND AREA */}
         {commandArea && (
           <div className={`absolute bottom-10 left-1/2 -translate-x-1/2 w-full max-w-[800px] z-50 px-5 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${hideCommandArea ? 'opacity-0 pointer-events-none translate-y-5' : 'opacity-100 translate-y-0'}`}>
             {commandArea}
           </div>
         )}
      </div>

      {/* RIGHT SIDEBAR */}
      {rightSidebar && (
        <div className="group/right z-40 absolute inset-y-0 right-0 flex">
          {/* Drawer */}
          <div className="absolute top-0 right-[-380px] w-[360px] max-w-[90vw] h-full bg-bg/80 backdrop-blur-[40px] border-l border-border p-10 z-50 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] shadow-[-20px_0_50px_rgba(0,0,0,0.3)] peer-hover:right-0 hover:right-0 flex flex-col">
            {rightSidebar}
          </div>
          <div className="w-10 h-full flex items-center justify-end pr-2.5 cursor-pointer peer order-first">
            <div className="text-text-muted transition-all duration-300 group-hover/right:text-primary group-hover/right:scale-110 pointer-events-none">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
              </svg>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
