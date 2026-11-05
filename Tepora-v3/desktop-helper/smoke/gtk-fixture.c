/* A GTK3 window for the X11 smoke test. Declares the few GTK calls it uses, so it links against the
 * libgtk-3 runtime alone (no -dev headers). */
#include <stdio.h>
typedef void* P; typedef int gboolean;
extern void gtk_init(int*, char***); extern P gtk_window_new(int); extern void gtk_window_set_title(P,const char*);
extern void gtk_window_set_default_size(P,int,int); extern P gtk_box_new(int,int); extern void gtk_container_add(P,P);
extern void gtk_box_pack_start(P,P,gboolean,gboolean,unsigned); extern P gtk_button_new_with_label(const char*);
extern P gtk_entry_new(void); extern void gtk_entry_set_visibility(P,gboolean); extern void gtk_entry_set_text(P,const char*);
extern P gtk_check_button_new_with_label(const char*); extern P gtk_combo_box_text_new(void);
extern void gtk_combo_box_text_append_text(P,const char*); extern void gtk_combo_box_set_active(P,int);
extern P gtk_label_new(const char*); extern void gtk_label_set_text(P,const char*); extern void gtk_widget_show_all(P); extern void gtk_main(void);
extern void gtk_main_quit(void); extern unsigned long g_signal_connect_data(P,const char*,void*,P,P,int);
extern const char* gtk_entry_get_text(P); extern void gtk_window_move(P,int,int);
static P status, entry;
static int clicks=0;
static void on_click(P b, P d){ char buf[64]; clicks++; snprintf(buf,64,"Clicked %d", clicks); gtk_label_set_text(status,buf); printf("clicked %d\n",clicks); fflush(stdout);}
static void on_changed(P e, P d){ printf("entry=%s\n", gtk_entry_get_text(e)); fflush(stdout);}
static void on_combo(P c, P d){ printf("combo changed\n"); fflush(stdout);}
int main(int argc,char**argv){
  gtk_init(&argc,&argv);
  P w=gtk_window_new(0); gtk_window_set_title(w,"Tepora Test"); gtk_window_set_default_size(w,360,300); gtk_window_move(w,40,30);
  g_signal_connect_data(w,"destroy",(void*)gtk_main_quit,0,0,0);
  P box=gtk_box_new(1,4); gtk_container_add(w,box);
  P b=gtk_button_new_with_label("Press me"); g_signal_connect_data(b,"clicked",(void*)on_click,0,0,0);
  entry=gtk_entry_new(); g_signal_connect_data(entry,"changed",(void*)on_changed,0,0,0);
  P pw=gtk_entry_new(); gtk_entry_set_visibility(pw,0); gtk_entry_set_text(pw,"hunter2");
  P chk=gtk_check_button_new_with_label("Remember");
  P combo=gtk_combo_box_text_new(); gtk_combo_box_text_append_text(combo,"One"); gtk_combo_box_text_append_text(combo,"Two"); gtk_combo_box_text_append_text(combo,"Three"); gtk_combo_box_set_active(combo,0);
  g_signal_connect_data(combo,"changed",(void*)on_combo,0,0,0);
  status=gtk_label_new("Ready");
  P parts[]={b,entry,pw,chk,combo,status};
  for(int i=0;i<6;i++) gtk_box_pack_start(box,parts[i],0,0,0);
  gtk_widget_show_all(w); gtk_main(); return 0;}
